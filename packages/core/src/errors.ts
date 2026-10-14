export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
}
export class ApprovalRequiredError extends Error {
  override readonly name = 'ApprovalRequiredError';
}
export class ApprovalError extends Error {
  override readonly name = 'ApprovalError';
}
export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(
    message: string,
    readonly details: { scope: 'persona' | 'studio'; unit: string; used: number; cap: number; requested: number },
  ) {
    super(message);
  }
}
export class PublishBlockedError extends Error {
  override readonly name = 'PublishBlockedError';
  constructor(readonly reasons: readonly string[]) {
    super(`publish blocked: ${reasons.join('; ')}`);
  }
}
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}
/** The actor isn't allowed to make this change (e.g. an agent raising caps or autonomy). */
export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
}
