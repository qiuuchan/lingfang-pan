import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { IsEmail, IsString, IsUUID } from 'class-validator';
import { Public, requireUser } from '../../common';
import { requireWebCsrf, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from '../../security';
import { WebSessionService } from './web-session.service';

class WebLoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}

class WebSwitchTeamDto {
  @IsUUID() teamId!: string;
}

const secure = () => process.env.NODE_ENV === 'production';
const sessionCookie = {
  httpOnly: true,
  secure: secure(),
  sameSite: 'lax' as const,
  path: '/api',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const csrfCookie = {
  httpOnly: false,
  secure: secure(),
  sameSite: 'lax' as const,
  path: '/api',
  maxAge: 24 * 60 * 60 * 1000,
};

@Controller('web/session')
export class WebSessionController {
  constructor(@Inject(WebSessionService) private readonly sessions: WebSessionService) {}

  @Public()
  @Get('csrf')
  csrf(@Res({ passthrough: true }) response: Response) {
    const csrfToken = randomBytes(32).toString('base64url');
    response.cookie(WEB_CSRF_COOKIE, csrfToken, csrfCookie);
    return { csrfToken };
  }

  @Public()
  @Post('login')
  async login(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: WebLoginDto
  ) {
    requireWebCsrf(request);
    const result = await this.sessions.login(body.email, body.password);
    response.cookie(WEB_SESSION_COOKIE, result.token, sessionCookie);
    return result.session;
  }

  @Get()
  current(@Req() request: Request) {
    const user = requireUser(request);
    return this.sessions.current(user.id, user.teamId);
  }

  @Get('teams')
  teams(@Req() request: Request) {
    return this.sessions.teams(requireUser(request).id);
  }

  @Post('team')
  async switchTeam(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: WebSwitchTeamDto
  ) {
    const result = await this.sessions.switchTeam(requireUser(request).id, body.teamId);
    response.cookie(WEB_SESSION_COOKIE, result.token, sessionCookie);
    return result.session;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(WEB_SESSION_COOKIE, { ...sessionCookie, maxAge: undefined });
    response.clearCookie(WEB_CSRF_COOKIE, { ...csrfCookie, maxAge: undefined });
    return { ok: true };
  }
}
