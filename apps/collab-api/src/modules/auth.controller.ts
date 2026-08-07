import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, requireUser } from '../common';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from '../security';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
  AdminForgotPasswordDto,
  AdminLoginDto,
} from './dto/auth.dto';

// 管理端会话 Cookie（镜像 web-session.controller 的 web 会话方案）。
// session：HttpOnly + 同源 path=/api，7 天；csrf：可读（非 HttpOnly）供前端读取放入 x-csrf-token，1 天。
// secure 仅生产（HTTPS）置位；开发（HTTP localhost）不置位以便浏览器存储。
const secure = () => process.env.NODE_ENV === 'production';
const adminSessionCookie = {
  httpOnly: true,
  secure: secure(),
  sameSite: 'lax' as const,
  path: '/api',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const adminCsrfCookie = {
  httpOnly: false,
  secure: secure(),
  sameSite: 'lax' as const,
  path: '/api',
  maxAge: 24 * 60 * 60 * 1000,
};

// 敏感鉴权端点统一限流：10 次/分钟/IP（Top9）。
// 防暴力破解密码、注册轰炸、找回密码邮件轰炸。全局默认 60 次/分钟，此处收紧到 10。
const AUTH_THROTTLE = Throttle({ default: { limit: 10, ttl: 60_000 } });

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '本地客户端注册普通用户或提交团队管理员申请（无验证码）' })
  register(@Body() body: RegisterDto) {
    return this.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      wantsTeamAdmin: body.wantsTeamAdmin,
      teamName: body.teamName,
      reason: body.reason,
    });
  }

  @Public()
  @Post('login')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '本地客户端登录（无验证码）' })
  login(@Body() body: LoginDto) {
    return this.auth.login({ email: body.email, password: body.password });
  }

  @Public()
  @Post('admin/login')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '管理端登录（按平台配置校验验证码）' })
  async adminLogin(@Res({ passthrough: true }) res: Response, @Body() body: AdminLoginDto) {
    const session = await this.auth.adminLogin({
      email: body.email,
      password: body.password,
      captcha: body.captcha,
    });
    // 下发 HttpOnly 会话 Cookie + 可读 CSRF Cookie；Body 仍返回 token 以兼容非浏览器客户端。
    res.cookie(ADMIN_SESSION_COOKIE, session.token, adminSessionCookie);
    res.cookie(ADMIN_CSRF_COOKIE, randomBytes(32).toString('base64url'), adminCsrfCookie);
    return session;
  }

  @Public()
  @Post('forgot-password')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '应用端找回密码：发送重置链接邮件（无验证码）' })
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.forgotPassword({ email: body.email });
  }

  @Public()
  @Post('admin/forgot-password')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '管理端找回密码：按平台配置校验验证码后发送重置链接邮件' })
  adminForgotPassword(@Body() body: AdminForgotPasswordDto) {
    return this.auth.adminForgotPassword({ email: body.email, captcha: body.captcha });
  }

  @Public()
  @Post('reset-password')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '重置密码：校验 reset token + 改密 + tokenVersion++' })
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body);
  }

  @Public()
  @Post('verify-email')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '验证邮箱：校验 verify token + 标记 emailVerified' })
  verifyEmail(@Body() body: VerifyEmailDto) {
    return this.auth.verifyEmail(body);
  }

  @Post('resend-verification')
  @ApiBearerAuth()
  @AUTH_THROTTLE
  @ApiOperation({ summary: '重发邮箱验证邮件（登录态，已验证用户幂等返回）' })
  resendVerification(@Req() req: Request) {
    return this.auth.resendVerification(requireUser(req).id);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前会话和下一步 onboarding 状态' })
  me(@Req() req: Request) {
    return this.auth.me(requireUser(req).id);
  }

  @Public()
  @Get('admin/csrf')
  @ApiOperation({
    summary: '获取管理端 CSRF 令牌（写入可读 Cookie，前端读取后放于 x-csrf-token 头）',
  })
  adminCsrf(@Res({ passthrough: true }) res: Response) {
    const csrfToken = randomBytes(32).toString('base64url');
    res.cookie(ADMIN_CSRF_COOKIE, csrfToken, adminCsrfCookie);
    return { csrfToken };
  }

  @Post('refresh')
  @ApiBearerAuth()
  @ApiOperation({ summary: '刷新当前会话（基于 Cookie 滑动续签，重新下发会话 Cookie）' })
  async refresh(@Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const session = await this.auth.refresh(requireUser(req).id);
    res.cookie(ADMIN_SESSION_COOKIE, session.token, adminSessionCookie);
    return session;
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: '退出登录；清除管理端会话与 CSRF Cookie' })
  async logout(@Res({ passthrough: true }) res: Response, @Req() req: Request) {
    res.clearCookie(ADMIN_SESSION_COOKIE, { ...adminSessionCookie, maxAge: undefined });
    res.clearCookie(ADMIN_CSRF_COOKIE, { ...adminCsrfCookie, maxAge: undefined });
    return this.auth.logout(requireUser(req).id);
  }
}
