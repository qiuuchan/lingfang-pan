// 通知相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制。
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** GET /api/notifications?unreadOnly=&limit= 入参（全可选）。
 *  - unreadOnly：true 仅返回未读（默认 false 返回全部）。
 *  - limit：每页条数，clamp 到 [1,100]（service 内强制），默认 50。 */
export class NotificationListQueryDto {
  @ApiPropertyOptional({ description: '仅返回未读（默认 false 返回全部）' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 50）', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1, { message: 'limit 至少为 1' })
  @Max(100, { message: 'limit 最多为 100' })
  limit?: number;
}
