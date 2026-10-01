import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { TurnwayService, type WaitingRoomStats, type WaitingRoomStatus } from 'turnway';
import { DEMO_ROOM_ID } from './constants';
import { DemoUser } from './demo-user';

/** HTTP surface of the browser demo. Every queue operation goes through the injected service */
@Controller('api')
export class DemoController {
  constructor(private readonly turnway: TurnwayService) {}

  @Get('stats')
  stats(): Promise<WaitingRoomStats> {
    return this.turnway.stats(DEMO_ROOM_ID);
  }

  /** Returns the caller's existing live pass instead of creating a second one */
  @Post('join')
  @HttpCode(200)
  join(@DemoUser() userId: string): Promise<WaitingRoomStatus> {
    return this.turnway.join(DEMO_ROOM_ID, userId);
  }

  @Get('passes/:passId')
  check(@DemoUser() userId: string, @Param('passId') passId: string): Promise<WaitingRoomStatus> {
    return this.turnway.check(DEMO_ROOM_ID, userId, passId);
  }

  @Post('passes/:passId/heartbeat')
  @HttpCode(200)
  heartbeat(@DemoUser() userId: string, @Param('passId') passId: string): Promise<WaitingRoomStatus> {
    return this.turnway.heartbeat(DEMO_ROOM_ID, userId, passId);
  }

  @Post('passes/:passId/leave')
  @HttpCode(200)
  leave(@DemoUser() userId: string, @Param('passId') passId: string): Promise<WaitingRoomStatus> {
    return this.turnway.leave(DEMO_ROOM_ID, userId, passId);
  }

  /** Stand-in for booking or payment work, run only after the server verifies admission */
  @Post('passes/:passId/protected')
  @HttpCode(200)
  async protectedWork(
    @DemoUser() userId: string,
    @Param('passId') passId: string,
  ): Promise<{ result: string; sessionEndsAt: number }> {
    const session = await this.turnway.assertAdmitted(DEMO_ROOM_ID, userId, passId);
    return { result: `Seat reserved for ${userId.slice(0, 8)}`, sessionEndsAt: session.sessionEndsAt };
  }
}
