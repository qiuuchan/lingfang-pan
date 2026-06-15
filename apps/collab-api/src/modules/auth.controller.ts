import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public, requireUser } from '../common';
import { AuthService } from './auth.service';
import { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto, VerifyEmailDto } from './dto/auth.dto';

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
  @ApiOperation({ summary: '本地客户端注册普通用户或提交团队管理员申请' })
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '本地客户端和管理端共用登录' })
  login(@Body() body: LoginDto) {
    return this.auth.login(body);
  }

  @Public()
  @Post('forgot-password')
  @AUTH_THROTTLE
  @ApiOperation({ summary: '找回密码：发送重置链接邮件（占位 SMTP 未配时降级 console.log）' })
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.forgotPassword(body);
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

  @Post('refresh')
  @ApiBearerAuth()
  @ApiOperation({ summary: '刷新当前会话' })
  refresh(@Req() req: Request) {
    return this.auth.refresh(requireUser(req).id);
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: '退出登录；当前版本为无状态 JWT 客户端清理' })
  logout(@Req() req: Request) {
    return this.auth.logout(requireUser(req).id);
  }
}