export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'يجب تسجيل الدخول') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'ليست لديك صلاحية لتنفيذ هذه العملية') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'العنصر غير موجود') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
