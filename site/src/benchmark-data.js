// v0.1.7 complete combined round. Source:
// evals/results/v0.1.7-2fbc92b/{anchor,external}/summary.json
// The measured source is 2fbc92b; the v0.1.7 tag is 08472b1.
// External SWE-agent did not report cost or cache, so those values are null.
export const rounds = [
  {
    "bench": "swe-lite",
    "benchLabel": "SWE Lite",
    "model": "deepseek/deepseek-v4.1-flash-1017",
    "modelLabel": "DeepSeek V4.1 Flash",
    "harness": "SWE-agent",
    "anchor": {
      "tasks": 10,
      "scored": 9,
      "full": 7,
      "mean": 0.7777777777777778,
      "prompt": 7581067,
      "completion": 270693,
      "cached": 7154048,
      "usd": 0.30230867000000006,
      "p50": 308504,
      "p95": 1020968
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 0,
      "mean": 0,
      "prompt": 29682106,
      "completion": 5790,
      "cached": 0,
      "usd": null,
      "p50": 712361,
      "p95": 1879206
    }
  },
  {
    "bench": "swe-lite",
    "benchLabel": "SWE Lite",
    "model": "qwen/qwen3-coder-next",
    "modelLabel": "Qwen3 Coder Next",
    "harness": "SWE-agent",
    "anchor": {
      "tasks": 10,
      "scored": 8,
      "full": 4,
      "mean": 0.5,
      "prompt": 28805767,
      "completion": 140984,
      "cached": 28070944,
      "usd": 2.16593204,
      "p50": 333923,
      "p95": 758331
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 0,
      "mean": 0,
      "prompt": 38177840,
      "completion": 85832,
      "cached": 0,
      "usd": 0,
      "p50": 176303,
      "p95": 1867554
    }
  },
  {
    "bench": "swe-pro",
    "benchLabel": "SWE Pro",
    "model": "deepseek/deepseek-v4.1-flash-1017",
    "modelLabel": "DeepSeek V4.1 Flash",
    "harness": "SWE-agent",
    "anchor": {
      "tasks": 10,
      "scored": 10,
      "full": 10,
      "mean": 1,
      "prompt": 20837780,
      "completion": 772609,
      "cached": 19848320,
      "usd": 0.7403360639999998,
      "p50": 666097,
      "p95": 2963025
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 6,
      "mean": 0.6,
      "prompt": 25729379,
      "completion": 8333,
      "cached": 0,
      "usd": null,
      "p50": 1281262,
      "p95": 6058938
    }
  },
  {
    "bench": "swe-pro",
    "benchLabel": "SWE Pro",
    "model": "qwen/qwen3-coder-next",
    "modelLabel": "Qwen3 Coder Next",
    "harness": "SWE-agent",
    "anchor": {
      "tasks": 10,
      "scored": 10,
      "full": 5,
      "mean": 0.5,
      "prompt": 35149840,
      "completion": 146733,
      "cached": 34324768,
      "usd": 2.6191288,
      "p50": 430576,
      "p95": 1119187
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 3,
      "mean": 0.3,
      "prompt": 89839646,
      "completion": 63515,
      "cached": 0,
      "usd": null,
      "p50": 1010271,
      "p95": 3583854
    }
  },
  {
    "bench": "terminal-bench",
    "benchLabel": "Terminal",
    "model": "deepseek/deepseek-v4.1-flash-1017",
    "modelLabel": "DeepSeek V4.1 Flash",
    "harness": "Terminus-2",
    "anchor": {
      "tasks": 10,
      "scored": 10,
      "full": 7,
      "mean": 0.7,
      "prompt": 7382691,
      "completion": 397206,
      "cached": 6673469,
      "usd": 0.4547343880000001,
      "p50": 457653,
      "p95": 1032997
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 8,
      "mean": 0.8,
      "prompt": 3906623,
      "completion": 407844,
      "cached": 2795520,
      "usd": 0.5770792779999999,
      "p50": 389871,
      "p95": 1177896
    }
  },
  {
    "bench": "terminal-bench",
    "benchLabel": "Terminal",
    "model": "qwen/qwen3-coder-next",
    "modelLabel": "Qwen3 Coder Next",
    "harness": "Terminus-2",
    "anchor": {
      "tasks": 10,
      "scored": 10,
      "full": 1,
      "mean": 0.1,
      "prompt": 23554177,
      "completion": 288729,
      "cached": 22843104,
      "usd": 1.9153292399999997,
      "p50": 592951,
      "p95": 1132293
    },
    "external": {
      "tasks": 10,
      "scored": 10,
      "full": 3,
      "mean": 0.3,
      "prompt": 11910959,
      "completion": 184843,
      "cached": 11414208,
      "usd": 1.00647908,
      "p50": 938036,
      "p95": 2257796
    }
  }
];

export const sweLiteDeepSeek = {
  bench: "SWE Lite",
  model: "DeepSeek V4.1 Flash",
  harness: "SWE-agent",
  tasks: [
  {
    "id": "django__django-10914",
    "anchor": {
      "reward": 0,
      "status": "completed",
      "steps": 41,
      "wallMs": 273104,
      "tokens": 969838,
      "usd": 0.027697146000000002,
      "falseFinish": true
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 867867,
      "tokens": 3162695,
      "usd": null
    }
  },
  {
    "id": "matplotlib__matplotlib-18869",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 35,
      "wallMs": 206292,
      "tokens": 629864,
      "usd": 0.017394156000000004,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 712361,
      "tokens": 1914918,
      "usd": null
    }
  },
  {
    "id": "mwaskom__seaborn-2848",
    "anchor": {
      "reward": 1,
      "status": "timeout",
      "steps": 36,
      "wallMs": 1020968,
      "tokens": 903269,
      "usd": 0.031097680000000003,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 1220494,
      "tokens": 3623764,
      "usd": null
    }
  },
  {
    "id": "pallets__flask-4045",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 37,
      "wallMs": 263525,
      "tokens": 775259,
      "usd": 0.027138315999999992,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 154981,
      "tokens": 174149,
      "usd": null
    }
  },
  {
    "id": "psf__requests-1963",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 39,
      "wallMs": 310175,
      "tokens": 694010,
      "usd": 0.02472153,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 878186,
      "tokens": 2031630,
      "usd": null
    }
  },
  {
    "id": "pydata__xarray-3364",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 36,
      "wallMs": 269685,
      "tokens": 910005,
      "usd": 0.037672148,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "failed",
      "wallMs": 1879206,
      "tokens": 16347956,
      "usd": null
    }
  },
  {
    "id": "pylint-dev__pylint-5859",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 35,
      "wallMs": 344562,
      "tokens": 478716,
      "usd": 0.027867348000000004,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 237466,
      "tokens": 563597,
      "usd": null
    }
  },
  {
    "id": "pytest-dev__pytest-11143",
    "anchor": {
      "reward": 1,
      "status": "completed",
      "steps": 29,
      "wallMs": 308504,
      "tokens": 492987,
      "usd": 0.014897526000000005,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 307750,
      "tokens": 524146,
      "usd": null
    }
  },
  {
    "id": "sphinx-doc__sphinx-10325",
    "anchor": {
      "status": "failed",
      "steps": 47,
      "wallMs": 265365,
      "tokens": 1183203,
      "usd": 0.059018976,
      "falseFinish": false
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 283210,
      "tokens": 951634,
      "usd": null
    }
  },
  {
    "id": "sympy__sympy-11400",
    "anchor": {
      "reward": 0,
      "status": "completed",
      "steps": 41,
      "wallMs": 332109,
      "tokens": 814609,
      "usd": 0.034803844,
      "falseFinish": true
    },
    "external": {
      "reward": 0,
      "status": "completed",
      "wallMs": 154906,
      "tokens": 393407,
      "usd": null
    }
  }
],
};
