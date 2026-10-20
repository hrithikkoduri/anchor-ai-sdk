// Historical OpenRouter baseline; do not mix with the completed Parasail round.
// Source: evals/benchmarks/swe-bench/results/comparison.md (2026-10-18).
// Each arm: resolved, steps, seconds, tokens, USD. Mini tokens/cost are estimates.
export const tasks = [
  {
    id: "psf__requests-1963",
    anchor: [true, 23, 108, 177957, 0.0206],
    mini: [true, 39, 501, 2820846, 0.3279],
  },
  {
    id: "pytest-dev__pytest-11143",
    anchor: [true, 28, 113, 292486, 0.0309],
    mini: [true, 41, 214, 3828068, 0.4533],
  },
  {
    id: "pallets__flask-4045",
    anchor: [false, 38, 185, 508940, 0.0584],
    mini: [false, 22, 51, 323709, 0.0485],
  },
  {
    id: "pylint-dev__pylint-5859",
    anchor: [true, 47, 950, 817682, 0.0985],
    mini: [true, 23, 72, 401857, 0.0585],
  },
  {
    id: "mwaskom__seaborn-2848",
    anchor: [false, 27, 576, 257551, 0.0295],
    mini: [true, 51, 353, 2614432, 0.271],
  },
  {
    id: "sphinx-doc__sphinx-10325",
    anchor: [true, 52, 220, 773988, 0.0834],
    mini: [true, 47, 325, 3819953, 0.4268],
  },
  {
    id: "django__django-10914",
    anchor: [true, 25, 73, 180043, 0.0176],
    mini: [true, 23, 143, 461678, 0.0627],
  },
  {
    id: "sympy__sympy-11400",
    anchor: [false, 20, 59, 135264, 0.0146],
    mini: [false, 21, 102, 303459, 0.0409],
  },
  {
    id: "matplotlib__matplotlib-18869",
    anchor: [true, 44, 539, 930808, 0.1206],
    mini: [false, 15, 62, 225355, 0.0414],
  },
  {
    id: "pydata__xarray-3364",
    anchor: [true, 56, 1315, 1210218, 0.1296],
    mini: [true, 34, 359, 2195362, 0.256],
  },
];

// Source totals use unrounded run values; displayed row sums may differ slightly.
export const totals = {
  anchor: {
    resolved: 7,
    steps: 360,
    seconds: 4137,
    tokens: 5284937,
    usd: 0.6036,
  },
  mini: {
    resolved: 7,
    steps: 316,
    seconds: 2182,
    tokens: 16994719,
    usd: 1.9871,
  },
};
