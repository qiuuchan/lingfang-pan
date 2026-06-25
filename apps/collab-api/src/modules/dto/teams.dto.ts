import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

/** 生成团队邀请码请求体 DTO。 */
export class CreateInvitationDto {
  @ApiPropertyOptional({ description: '邀请码最大使用次数（>=1，默认 1）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'maxUses 必须是整数' })
  @Min(1, { message: 'maxUses 至少为 1' })
  maxUses?: number;

  @ApiPropertyOptional({ description: '过期时间（ISO 8601 字符串），不早于当前' })
  @IsOptional()
  @IsDateString({}, { message: 'expiresAt 不是合法日期' })
  expiresAt?: string;
}

/** 消耗团队共享余额请求体 DTO。amountCents 必须为正整数。 */
export class ConsumeBalanceDto {
  @ApiProperty({ description: '消耗金额（分），正整数' })
  @Type(() => Number)
  @IsInt({ message: 'amountCents 必须是正整数' })
  @Min(1, { message: 'amountCents 必须大于 0' })
  amountCents!: number;

  @ApiPropertyOptional({ description: '消耗原因（写入流水）' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 凭邀请码加入团队请求体 DTO。 */
export class RedeemInvitationDto {
  @ApiProperty({ description: '团队邀请码' })
  @IsString()
  code!: string;
}

/**
 * 更新团队公开发现设置请求体 DTO。
 * allowPublicJoin 切换是否出现在「发现公开团队」列表；description 为发现页展示简介（限 500 字）。
 */
export class UpdateTeamProfileDto {
  @ApiPropertyOptional({ description: '是否开放公开加入（true=出现在发现页）' })
  @IsOptional()
  @IsBoolean({ message: 'allowPublicJoin 必须是布尔值' })
  allowPublicJoin?: boolean;

  @ApiPropertyOptional({ description: '团队简介（发现页展示，≤500 字）' })
  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * 设置团队默认资源池请求体 DTO。
 * defaultPoolId 为空表示取消默认池子。
 */
export class UpdateDefaultPoolDto {
  @ApiPropertyOptional({ description: '默认资源池 ID（null 表示取消设置）' })
  @IsOptional()
  @IsString()
  defaultPoolId?: string | null;
}
