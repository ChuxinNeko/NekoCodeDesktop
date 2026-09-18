/** Snapshot: CLIProxyAPI/internal/registry/models/models.json (Antigravity chat models). */
export const ANTIGRAVITY_CATALOG = [
  {
    "id": "claude-opus-4-6-thinking",
    "name": "Claude Opus 4.6 (Thinking)",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "thinking": {
      "min": 1024,
      "max": 64000,
      "zero_allowed": true,
      "dynamic_allowed": true
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Claude Sonnet 4.6 (Thinking)",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "thinking": {
      "min": 1024,
      "max": 64000,
      "zero_allowed": true,
      "dynamic_allowed": true
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3.6-flash-high",
    "name": "Gemini 3.6 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3.7-flash-high",
    "name": "Gemini 3.7 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3.8-flash-high",
    "name": "Gemini 3.8 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3-flash",
    "name": "Gemini 3 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "thinking": {
      "min": 128,
      "max": 32768,
      "dynamic_allowed": true,
      "levels": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-pro-agent",
    "name": "Gemini 3.1 Pro (High)",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3.1-pro-low",
    "name": "Gemini 3.1 Pro (Low)",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gpt-oss-120b-medium",
    "name": "GPT-OSS 120B (Medium)",
    "contextWindow": 114000,
    "maxTokens": 32768,
    "thinking": null,
    "input": [
      "text"
    ]
  },
  {
    "id": "gemini-3.1-flash-lite",
    "name": "Gemini 3.1 Flash Lite",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "thinking": {
      "min": 1,
      "max": 65535,
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  },
  {
    "id": "gemini-3.5-flash-lite",
    "name": "Gemini 3.5 Flash Lite",
    "contextWindow": 1048576,
    "maxTokens": 65535,
    "thinking": {
      "min": 1,
      "max": 65535,
      "dynamic_allowed": true,
      "levels": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "input": [
      "text",
      "image"
    ]
  }
] as const;
