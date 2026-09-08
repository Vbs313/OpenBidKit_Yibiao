const FINDING_SCHEMA = {
  type: 'object',
  required: ['id', 'code', 'title', 'message', 'severity', 'evidence', 'suggestion'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    code: { type: 'string' },
    title: { type: 'string' },
    message: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
    evidence: { type: 'string' },
    suggestion: { type: 'string' },
    location: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file: { type: ['string', 'null'] },
        line: { type: ['integer', 'null'], minimum: 1 },
      },
    },
  },
};

const CHECK_RESULT_SCHEMA = {
  type: 'object',
  required: ['check_id', 'check_name', 'status', 'severity', 'summary', 'metrics', 'findings', 'usage'],
  additionalProperties: true,
  properties: {
    check_id: { type: 'string' },
    check_name: { type: 'string' },
    status: { type: 'string', enum: ['pass', 'fail', 'warning', 'error'] },
    severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
    summary: { type: 'string' },
    metrics: {
      type: 'object',
      required: ['total', 'passed', 'failed', 'warning'],
      additionalProperties: true,
      properties: {
        total: { type: 'integer', minimum: 0 },
        passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        warning: { type: 'integer', minimum: 0 },
      },
    },
    findings: { type: 'array', items: FINDING_SCHEMA },
    usage: {
      type: 'object',
      required: ['model', 'prompt_tokens', 'completion_tokens'],
      additionalProperties: true,
      properties: {
        model: { type: ['string', 'null'] },
        prompt_tokens: { type: 'integer', minimum: 0 },
        completion_tokens: { type: 'integer', minimum: 0 },
      },
    },
  },
};

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['version', 'job_id', 'status', 'results'],
  additionalProperties: true,
  properties: {
    version: { type: 'string', const: '1.0' },
    job_id: { type: 'string' },
    status: { type: 'string', enum: ['success', 'error'] },
    results: { type: 'array', items: CHECK_RESULT_SCHEMA },
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        detail: { type: 'string' },
      },
    },
    message: { type: 'string' },
    checks: { type: 'array' },
  },
};

module.exports = {
  CHECK_RESULT_SCHEMA,
  FINDING_SCHEMA,
  RESPONSE_SCHEMA,
};
