export interface HttpErrorResponse {
  statusCode: number;
  payload: { error: { code: string; message?: string } };
}

export function toHttpError(error: { code: string; message?: string }): HttpErrorResponse {
  const statusCode = statusFor(error.code);
  return {
    statusCode,
    payload: {
      error: {
        code: error.code,
        ...(error.message ? { message: error.message } : {}),
      },
    },
  };
}

const statusFor = (code: string): number => {
  if (["VALIDATION_ERROR", "INVALID_TIME_RANGE"].includes(code)) return 400;
  if (["CUSTOMER_NOT_FOUND", "SERVICE_NOT_FOUND", "EMPLOYEE_NOT_FOUND", "APPOINTMENT_NOT_FOUND"].includes(code)) return 404;
  if (["SLOT_NO_LONGER_AVAILABLE", "SLOT_CONFLICT", "IDEMPOTENCY_CONFLICT", "APPOINTMENT_VERSION_CONFLICT", "APPOINTMENT_OPERATION_IN_PROGRESS", "CALL_ENDED"].includes(code)) return 409;
  if (["CALENDAR_SYNC_FAILED", "EXTERNAL_CALENDAR_UNAVAILABLE"].includes(code)) return 503;
  return 422;
};
