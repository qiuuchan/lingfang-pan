import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CloudActionTargetDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) package_id!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) release_id!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256!: string;
  @ApiProperty() @Matches(/^[a-z][a-z0-9._-]{0,63}$/) action_id!: string;
  @ApiProperty()
  @Matches(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  )
  action_contract_version!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) action_surface_sha256!: string;
  @ApiProperty({ enum: ['PREVIEW', 'PRODUCTION'] }) @IsIn(['PREVIEW', 'PRODUCTION']) environment!:
    'PREVIEW' | 'PRODUCTION';
}

export class CreateCloudActionDeploymentDto {
  @ApiProperty({ type: CloudActionTargetDto })
  @ValidateNested()
  @Type(() => CloudActionTargetDto)
  target!: CloudActionTargetDto;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  deployment_key!: string;
  @ApiProperty()
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_tld: false },
    { message: 'endpoint_url 必须是 HTTPS URL' }
  )
  @MaxLength(2048)
  endpoint_url!: string;
  @ApiPropertyOptional({ default: 30000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeout_ms?: number;
  @ApiPropertyOptional({ default: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  max_concurrency?: number;
  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  rate_limit_per_minute?: number;
  @ApiPropertyOptional({ default: 1048576 })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(16 * 1024 * 1024)
  response_limit_bytes?: number;
}

export class UpdateCloudActionRoutingDto {
  @ApiProperty()
  @Matches(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  )
  action_contract_version!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) action_surface_sha256!: string;
  @ApiProperty({ enum: ['PREVIEW', 'PRODUCTION'] }) @IsIn(['PREVIEW', 'PRODUCTION']) environment!:
    'PREVIEW' | 'PRODUCTION';
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) stable_deployment_id!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  candidate_deployment_id?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  candidate_percent?: number;
  @ApiProperty() @IsInt() @Min(0) expected_generation!: number;
}
