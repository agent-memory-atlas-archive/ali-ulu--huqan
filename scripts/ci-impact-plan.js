'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO_ROOT,
  discoverTestFiles,
} = require('./ci-shard-manifest');
const {
  buildDependencyIndex,
  selectionPlan,
  assertDerivedTestsSelected,
} = require('./ci-test-selection');
const {
  DOC_ONLY_PATTERNS,
  FULL_SUITE_PATTERNS,
  IMPACT_ONLY_PATTERNS,
  IMPACT_RULES,
  MUST_HAVE_PATTERNS,
} = require('./ci-impact-rules');

const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_PLAN = '.huqan/agent-test-plan.json';

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const value = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*') {
      if (value[index + 1] === '*') {
        if (value[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPattern(value, pattern) {
  return globToRegExp(pattern).test(normalizePath(value));
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function isTestFile(file) {
  const normalized = normalizePath(file);
  const base = path.posix.basename(normalized);
  return normalized.startsWith('test/')
    || base.endsWith('.test.js')
    || base.endsWith('.spec.js')
    || base.endsWith('-test.js')
    || base.endsWith('_test.js')
    || base.startsWith('test-')
    || base === 'test.js';
}

function isRuntimeOrTestFile(file) {
  const normalized = normalizePath(file);
  if (isTestFile(normalized)) return true;
  if (matchesAny(normalized, DOC_ONLY_PATTERNS)) return false;
  if (matchesAny(normalized, [
    'package.json',
    'package-lock.json',
    'plugins/**',
    'lib/**',
    'nlp/**',
    'packages/**',
    'migrations/**',
    'schemas/**',
    'adapters/**',
    'scripts/**',
    'benchmarks/**',
    'bin/**',
  ])) return true;
  if (normalized.includes('/')) return false;
  return normalized.endsWith('.js');
}

function discoverKnownTests(root = REPO_ROOT) {
  return discoverTestFiles(root).map(normalizePath).sort();
}

function addMatchingTests(target, reasons, knownTests, patterns, reason) {
  for (const file of knownTests) {
    if (!matchesAny(file, patterns)) continue;
    target.add(file);
    if (!reasons.has(file)) reasons.set(file, []);
    reasons.get(file).push(reason);
  }
}

function readChangedFiles({ root = REPO_ROOT, base, head, changedFiles } = {}) {
  if (Array.isArray(changedFiles)) return changedFiles.map(normalizePath).filter(Boolean).sort();
  if (!base || !head) throw new Error('base and head are required when changedFiles is not provided');
  const result = spawnSync('git', ['diff', '--name-only', base, head], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git diff exited with ${result.status}`);
  return result.stdout.split('\n').map(normalizePath).filter(Boolean).sort();
}

function validateAgentPlan(raw, knownTests) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent plan must be a JSON object');
  }
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`agent plan schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  }
  const allowedKeys = new Set(['schemaVersion', 'addTests', 'confidence', 'rationale', 'fallback']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`agent plan field is not allowed: ${key}`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'removeTests')) {
    throw new Error('agent plan cannot remove tests');
  }
  if (!Array.isArray(raw.addTests)) throw new Error('agent plan addTests must be an array');
  if (!['high', 'medium', 'low'].includes(raw.confidence)) throw new Error('agent plan confidence must be high, medium or low');
  const known = new Set(knownTests);
  const addTests = [...new Set(raw.addTests.map(normalizePath))].sort();
  const unknown = addTests.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`agent plan references unknown test files: ${unknown.join(', ')}`);
  if (raw.fallback !== undefined && !['full', 'none'].includes(raw.fallback)) {
    throw new Error('agent plan fallback must be full or none');
  }
  return { addTests, confidence: raw.confidence, rationale: String(raw.rationale || ''), fallback: raw.fallback || 'none' };
}

function loadAgentPlan({ root = REPO_ROOT, agentPlanPath, knownTests }) {
  const relative = agentPlanPath || DEFAULT_AGENT_PLAN;
  const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative);
  if (!fs.existsSync(absolute)) return { status: 'not-provided', addTests: [], confidence: null, rationale: '', fallback: 'none' };
  try {
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const plan = validateAgentPlan(raw, knownTests);
    return { status: 'valid', ...plan };
  } catch (error) {
    return { status: 'invalid', addTests: [], confidence: 'low', rationale: error.message, fallback: 'full' };
  }
}

function buildTestImpactPlan({ root = REPO_ROOT, base, head, changedFiles, mode = 'pr', runtimeOrTest, agentPlanPath, dependencyIndex } = {}) {
  const knownTests = discoverKnownTests(root);
  const changed = (!changedFiles && (mode === 'nightly' || mode === 'release') && (!base || !head))
    ? []
    : readChangedFiles({ root, base, head, changedFiles });
  const runtimeSignal = runtimeOrTest === undefined
    ? changed.some(isRuntimeOrTestFile)
    : Boolean(runtimeOrTest);
  const allTests = mode === 'nightly' || mode === 'release';
  const fullByPath = matchesAny(changed, FULL_SUITE_PATTERNS);
  const impactOnlyByPath = matchesAny(changed, IMPACT_ONLY_PATTERNS);
  const shouldRun = allTests || runtimeSignal || fullByPath || impactOnlyByPath;
  const deterministic = new Set();
  const reasons = new Map();
  let matchedRuleNames = [];
  let dependencyDerived = { tests: [], source: 'not-run' };

  if (shouldRun) {
    addMatchingTests(deterministic, reasons, knownTests, MUST_HAVE_PATTERNS, 'mandatory safety and contract union');
    for (const changedFile of changed) {
      if (knownTests.includes(changedFile)) {
        deterministic.add(changedFile);
        reasons.set(changedFile, ['changed test file']);
      }
      for (const rule of IMPACT_RULES) {
        if (!matchesAny(changedFile, rule.changed)) continue;
        matchedRuleNames.push(rule.name);
        addMatchingTests(deterministic, reasons, knownTests, rule.tests, `impact rule: ${rule.name}`);
      }
    }

    // Dependency-derived selection (#2610). The glob rules above are a
    // hand-maintained description of the tree, and #2505 C is what happens when
    // that description drifts: the plan looked healthy and selected none of the
    // five suites that then failed on main. This layer asks the source directly.
    // It only ever adds tests, so the union and the rules above remain the floor.
    const derived = selectionPlan(changed, dependencyIndex || buildDependencyIndex({ root }));
    dependencyDerived.tests = derived.tests;
    dependencyDerived.source = 'require graph plus named-file references';
    for (const [file, why] of derived.reasons) {
      if (!reasons.has(file)) reasons.set(file, []);
      for (const reason of why) {
        if (!reasons.get(file).includes(reason)) reasons.get(file).push(reason);
      }
      deterministic.add(file);
    }
  }

  const agent = loadAgentPlan({ root, agentPlanPath, knownTests });
  const fallbackFull = allTests || fullByPath || agent.status === 'invalid' || agent.confidence === 'low' || agent.fallback === 'full';
  const selected = fallbackFull && shouldRun ? [...knownTests] : [...deterministic, ...agent.addTests].filter((file, index, list) => list.indexOf(file) === index).sort();
  const selectedTests = selected.filter((file) => knownTests.includes(file));
  const selectedReasons = Object.fromEntries(selectedTests.map((file) => [file, reasons.get(file) || (agent.addTests.includes(file) ? ['agent addition'] : ['full-suite fallback'])]));

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode,
    base: base || null,
    head: head || null,
    changedFiles: changed,
    runTests: shouldRun,
    fullSuite: fallbackFull && shouldRun,
    knownTestCount: knownTests.length,
    selectedTestCount: selectedTests.length,
    selectedTests,
    mandatoryPatterns: [...MUST_HAVE_PATTERNS],
    matchedImpactRules: [...new Set(matchedRuleNames)].sort(),
    dependencyDerived,
    agent: {
      status: agent.status,
      confidence: agent.confidence,
      rationale: agent.rationale,
      addedTests: agent.addTests,
      fallback: agent.fallback,
    },
    selectedReasons,
    fallbackReason: fallbackFull ? (allTests ? 'nightly/release mode' : fullByPath ? 'high-risk manifest or workflow path' : agent.rationale || 'agent confidence or validation fallback') : null,
  };
}

function validateImpactPlan(plan, knownTests) {
  if (!plan || plan.schemaVersion !== PLAN_SCHEMA_VERSION) throw new Error('impact plan schemaVersion is invalid');
  if (!Array.isArray(plan.selectedTests) || !Array.isArray(plan.changedFiles)) throw new Error('impact plan arrays are invalid');
  const known = new Set(knownTests);
  const selected = [...new Set(plan.selectedTests)];
  if (selected.length !== plan.selectedTests.length) throw new Error('impact plan contains duplicate selected tests');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`impact plan references unknown tests: ${unknown.join(', ')}`);
  if (!plan.runTests && selected.length > 0) throw new Error('non-runtime impact plan must not select tests');
  if (plan.runTests) {
    const mandatory = new Set();
    addMatchingTests(mandatory, new Map(), knownTests, MUST_HAVE_PATTERNS, 'mandatory');
    for (const file of mandatory) {
      if (!selected.includes(file)) throw new Error(`impact plan omitted mandatory test: ${file}`);
    }
  }
  if (plan.fullSuite && plan.runTests && selected.length !== knownTests.length) {
    throw new Error('full-suite impact plan must select every known test');
  }
  if (!plan.agent || !Array.isArray(plan.agent.addedTests)) throw new Error('impact plan agent metadata is invalid');
  for (const file of plan.agent.addedTests) {
    if (!selected.includes(file)) throw new Error(`agent-added test is absent from selectedTests: ${file}`);
  }
  if (!plan.dependencyDerived || !Array.isArray(plan.dependencyDerived.tests)) {
    throw new Error('impact plan dependency-derived metadata is invalid');
  }
  assertDerivedTestsSelected(plan.dependencyDerived.tests, selected);
  return true;
}

function parseArgs(argv) {
  const options = { base: null, head: null, output: null, mode: 'pr', agentPlanPath: null, runtimeOrTest: undefined };
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'base') options.base = value;
    else if (key === 'head') options.head = value;
    else if (key === 'output') options.output = value;
    else if (key === 'mode') options.mode = value;
    else if (key === 'agent-plan') options.agentPlanPath = value;
    else if (key === 'runtime-or-test') options.runtimeOrTest = value === 'yes' || value === 'true';
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = buildTestImpactPlan(options);
    validateImpactPlan(plan, discoverKnownTests());
    const output = JSON.stringify(plan, null, 2);
    if (options.output) {
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(options.output, `${output}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_AGENT_PLAN,
  DOC_ONLY_PATTERNS,
  FULL_SUITE_PATTERNS,
  IMPACT_ONLY_PATTERNS,
  IMPACT_RULES,
  MUST_HAVE_PATTERNS,
  PLAN_SCHEMA_VERSION,
  buildTestImpactPlan,
  discoverKnownTests,
  globToRegExp,
  isRuntimeOrTestFile,
  matchesPattern,
  parseArgs,
  readChangedFiles,
  validateAgentPlan,
  validateImpactPlan,
};
