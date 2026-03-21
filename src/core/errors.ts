import type { Dict } from '../types/core.ts';

export interface AppErrorOptions {
  code?: string;
  status?: number | null;
  cause?: unknown;
  details?: Dict | null;
}

export class AppError extends Error {
  override name: string;
  code: string;
  status: number | null;
  override cause: unknown;
  details: Dict | null;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'APP_ERROR';
    this.status = options.status ?? null;
    this.cause = options.cause;
    this.details = options.details ?? null;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONFIG_ERROR' });
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'VALIDATION_ERROR' });
    this.name = 'ValidationError';
  }
}




