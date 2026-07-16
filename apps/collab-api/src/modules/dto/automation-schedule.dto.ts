import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateAutomationScheduleDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(256) workflow_release_id!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) workflow_release_sha256!: string;
  @ApiProperty({ enum: ['ONCE', 'DAILY', 'WEEKLY'] }) @IsIn(['ONCE', 'DAILY', 'WEEKLY']) kind!: 'ONCE' | 'DAILY' | 'WEEKLY';
  @ApiPropertyOptional() @ValidateIf((value) => value.kind === 'ONCE') @IsDateString() run_at?: string;
  @ApiPropertyOptional() @ValidateIf((value) => value.kind !== 'ONCE') @IsString() @MinLength(1) @MaxLength(100) time_zone?: string;
  @ApiPropertyOptional() @ValidateIf((value) => value.kind !== 'ONCE') @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) local_time?: string;
  @ApiPropertyOptional() @ValidateIf((value) => value.kind === 'WEEKLY') @IsInt() @Min(1) @Max(7) day_of_week?: number;
  @ApiProperty() @IsObject() input!: Record<string, unknown>;
}

export class UpdateAutomationScheduleDto extends CreateAutomationScheduleDto {
  @ApiProperty() @IsInt() @Min(1) expected_generation!: number;
}

export class ScheduleGenerationDto {
  @ApiProperty() @IsInt() @Min(1) expected_generation!: number;
}
