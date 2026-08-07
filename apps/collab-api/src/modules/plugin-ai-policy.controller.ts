import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { checkPluginAiPolicy } from './plugin-ai-policy';

class PluginAiPolicyFileDto {
  @ApiProperty({ description: '插件内相对路径' })
  @IsString()
  path!: string;

  @ApiProperty({ description: 'UTF-8 文本内容' })
  @IsString()
  content!: string;

  @ApiPropertyOptional({ description: '二进制文件标记；二进制内容不进入文本扫描' })
  @IsOptional()
  @IsBoolean()
  binary?: boolean;
}

class PluginAiPolicyCheckDto {
  @ApiProperty({ description: '插件 manifest 对象' })
  @IsObject()
  manifest!: Record<string, unknown>;

  @ApiProperty({ type: [PluginAiPolicyFileDto], description: '待检查的插件文本文件' })
  @IsArray()
  @ArrayMaxSize(1500)
  @ValidateNested({ each: true })
  @Type(() => PluginAiPolicyFileDto)
  files!: PluginAiPolicyFileDto[];
}

@ApiTags('Plugin Policy')
@ApiBearerAuth()
@Controller('plugins/policy')
export class PluginAiPolicyController {
  @Post('check')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '检查插件是否仅通过平台能力使用 chat/生图' })
  check(@Body() body: PluginAiPolicyCheckDto) {
    return checkPluginAiPolicy({ manifest: body.manifest, files: body.files });
  }
}
