export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'APP_ERROR';
    this.status = options.status ?? null;
    this.cause = options.cause;
    this.details = options.details ?? null;
  }
}

export class ConfigurationError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'CONFIG_ERROR' });
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'VALIDATION_ERROR' });
    this.name = 'ValidationError';
  }
}
