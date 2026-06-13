import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, requireUser } from '../common';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: '本地客户端注册普通用户或提交团队管理员申请' })
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: '本地客户端和管理端共用登录' })
  login(@Body() body: LoginDto) {
    return this.auth.login(body);
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
  logout() {
    return { ok: true };
  }
}