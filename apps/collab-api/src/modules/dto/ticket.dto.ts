// 帮助与反馈工单相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制。
// 注：带附件的提交/回复走 multipart，title/body/category 作为表单字段由本 DTO 校验；
//     文件由 FileFieldsInterceptor 处理，不在 DTO 内。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TICKET_CATEGORY, TICKET_PRIORITY, TICKET_STATUS } from './enums';

/** POST /api/tickets 表单字段（multipart，files 另由拦截器处理）。 */
export class TicketCreateDto {
  @ApiProperty({ description: '工单标题', example: '插件创建器返回空响应' })
  @IsString()
  @MinLength(1, { message: '标题不能为空' })
  @MaxLength(200, { message: '标题过长（最多 200 字）' })
  title!: string;

  @ApiProperty({ description: '问题描述（首条消息正文）' })
  @IsString()
  @MinLength(1, { message: '描述不能为空' })
  @MaxLength(10_000, { message: '描述过长（最多 10000 字）' })
  body!: string;

  @ApiPropertyOptional({ description: '工单分类（默认 OTHER）', enum: TICKET_CATEGORY })
  @IsOptional()
  @IsEnum(TICKET_CATEGORY, { message: 'category 只允许 BUG / FEATURE / ACCOUNT / OTHER' })
  category?: (typeof TICKET_CATEGORY)[number];
}

/** POST /api/tickets/:id/messages 与 admin 同名端点的表单字段（multipart）。
 *  body 允许为空（仅追加附件的消息），但 service 会要求 body 或附件至少有其一。 */
export class TicketMessageCreateDto {
  @ApiPropertyOptional({ description: '回复正文（可空，但需 body 或附件至少其一）' })
  @IsOptional()
  @IsString()
  @MaxLength(10_000, { message: '内容过长（最多 10000 字）' })
  body?: string;
}

/** GET /api/tickets?status=&limit= 前台本人工单列表入参。 */
export class TicketListQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤', enum: TICKET_STATUS })
  @IsOptional()
  @IsEnum(TICKET_STATUS)
  status?: (typeof TICKET_STATUS)[number];

  @ApiPropertyOptional({ description: '每页条数（1-50，默认 50）', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1, { message: 'limit 至少为 1' })
  @Max(50, { message: 'limit 最多为 50' })
  limit?: number;
}

/** GET /api/admin/tickets 后台工单列表入参（筛选 + 分页）。 */
export class AdminTicketListQueryDto {
  @ApiPropertyOptional({ description: '按状态过滤', enum: TICKET_STATUS })
  @IsOptional()
  @IsEnum(TICKET_STATUS)
  status?: (typeof TICKET_STATUS)[number];

  @ApiPropertyOptional({ description: '按分类过滤', enum: TICKET_CATEGORY })
  @IsOptional()
  @IsEnum(TICKET_CATEGORY)
  category?: (typeof TICKET_CATEGORY)[number];

  @ApiPropertyOptional({ description: '按团队 id 过滤' })
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional({ description: '标题关键词模糊搜索' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 至少为 1' })
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(100, { message: 'pageSize 最多为 100' })
  pageSize?: number;
}

/** PATCH /api/admin/tickets/:id 改状态/优先级（全可选，至少一项）。 */
export class AdminTicketUpdateDto {
  @ApiPropertyOptional({ description: '工单状态', enum: TICKET_STATUS })
  @IsOptional()
  @IsEnum(TICKET_STATUS, { message: 'status 只允许 OPEN / IN_PROGRESS / RESOLVED / CLOSED' })
  status?: (typeof TICKET_STATUS)[number];

  @ApiPropertyOptional({ description: '工单优先级', enum: TICKET_PRIORITY })
  @IsOptional()
  @IsEnum(TICKET_PRIORITY, { message: 'priority 只允许 LOW / NORMAL / HIGH' })
  priority?: (typeof TICKET_PRIORITY)[number];
}
