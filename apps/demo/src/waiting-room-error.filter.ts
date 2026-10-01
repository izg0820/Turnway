import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NotAdmittedError, WaitingRoomError, type WaitingRoomErrorCode } from 'turnway';

const HTTP_STATUS: Record<WaitingRoomErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  PASS_NOT_FOUND: 404,
  PASS_OWNER_MISMATCH: 403,
  NOT_ADMITTED: 403,
  STORAGE_FAILURE: 503,
  ROOM_NOT_REGISTERED: 500,
  ROOM_CONFIG_CONFLICT: 500,
};

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

/** Map library errors to HTTP responses, exposing only the code and pass state */
@Catch(WaitingRoomError)
export class WaitingRoomErrorFilter implements ExceptionFilter<WaitingRoomError> {
  catch(error: WaitingRoomError, host: ArgumentsHost): void {
    const state = error instanceof NotAdmittedError ? error.status.state : undefined;
    host
      .switchToHttp()
      .getResponse<JsonResponse>()
      .status(HTTP_STATUS[error.code])
      .json({ code: error.code, state });
  }
}
