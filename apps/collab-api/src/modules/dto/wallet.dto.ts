import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 钱包购买请求体 DTO。plugin_id 为插件主键 cuid。 */
export class PurchaseDto {
  @ApiProperty({ description: '要购买的市场插件 ID' })
  @IsString()
  plugin_id!: string;
}
