import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** 提交团队管理员申请请求体 DTO。 */
export class SubmitApplicationDto {
  @ApiProperty({ description: '团队名称' })
  @IsString()
  teamName!: string;

  @ApiPropertyOptional({ description: '申请理由' })
  @IsOptional()
  @IsString()
  reason?: string;
}
