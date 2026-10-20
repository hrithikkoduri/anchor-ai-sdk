// Completed published artifacts, reviewed at SDK source 5d6901d.
// Source directories: results/glm53-parasail and results/glm53-mini.
// Arm tuple: resolved, reported steps (nullable), task seconds, tokens, USD.
// Mini has no usage records. run.json totalUsd: 0 is NOT a measured free run.
export const tasks = [
  {
    id: "django__django-10914",
    anchor: [true, 37, 243.826, 563852, 0.25785376],
    mini: [true, 100, 3286.276, null, null],
  },
  {
    id: "matplotlib__matplotlib-18869",
    anchor: [true, 46, 1829.158, 740625, 0.39793392000000005],
    mini: [false, null, 408.754, null, null],
    miniOutcome: "empty_patch",
  },
  {
    id: "mwaskom__seaborn-2848",
    anchor: [true, 120, 1231.354, 4662541, 1.4578221199999997],
    mini: [true, 49, 562.648, null, null],
    anchorReason: "max_steps",
  },
  {
    id: "pallets__flask-4045",
    anchor: [true, 56, 248.738, 1283498, 0.48171087999999995],
    mini: [true, 35, 132.106, null, null],
  },
  {
    id: "psf__requests-1963",
    anchor: [true, 71, 287.814, 1180429, 0.46095380000000014],
    mini: [true, 34, 281.554, null, null],
  },
  {
    id: "pydata__xarray-3364",
    anchor: [true, 35, 1002.941, 734342, 0.32106531999999993],
    mini: [true, 61, 1297.641, null, null],
  },
  {
    id: "pylint-dev__pylint-5859",
    anchor: [true, 34, 139.501, 413279, 0.15242092],
    mini: [true, 74, 408.701, null, null],
  },
  {
    id: "pytest-dev__pytest-11143",
    anchor: [true, 21, 372.669, 235388, 0.10029736],
    mini: [true, 20, 182.838, null, null],
  },
  {
    id: "sphinx-doc__sphinx-10325",
    anchor: [true, 52, 617.039, 1208910, 0.5598264000000002],
    mini: [true, 43, 159.585, null, null],
  },
  {
    id: "sympy__sympy-11400",
    anchor: [false, 25, 62.819, 341098, 0.12630188],
    mini: [true, 38, 201.381, null, null],
  },
];

export const totals = {
  anchor: {
    resolved: 9,
    steps: 497,
    seconds: 6035.859,
    tokens: 11363962,
    usd: 4.31618636,
  },
  mini: {
    resolved: 9,
    steps: null,
    reportedSteps: 454,
    seconds: 6921.484,
    tokens: null,
    usd: null,
  },
};

export const round = {
  model: "zai-org/GLM-5.3",
  provider: "Parasail",
  temperature: 0,
  seed: 42,
  anchorPath: "glm53-parasail",
  miniPath: "glm53-mini",
  anchorLimits: "120 steps / 25M tokens",
  miniLimits: "mini's own loop: 250 steps / $3",
};
