import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { GeetestService } from './geetest.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [AuthController],
  // MailService 为 AuthService 依赖（找回密码发邮件），需在 AuthModule 提供。
  // GeetestService 为 AuthService 依赖（管理端登录/找回密码验证码校验），同样在此提供。
  // 同时 export 供 CollabModule 内其他模块复用（如未来通知系统）。
  providers: [AuthService, MailService, GeetestService, PrismaService],
  exports: [AuthService, MailService, GeetestService],
})
export class AuthModule {}