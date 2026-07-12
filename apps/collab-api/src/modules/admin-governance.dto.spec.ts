import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AdminRejectApplicationDto } from './dto/admin.dto';

describe('admin governance reason DTO', () => {
  it('trims before applying the 1..500 boundary', async () => {
    const dto = plainToInstance(AdminRejectApplicationDto, { reason: ` ${'a'.repeat(500)} ` });
    const errors = await validate(dto);

    expect(dto.reason).toHaveLength(500);
    expect(errors).toHaveLength(0);
  });

  it('rejects whitespace-only reasons after transformation', async () => {
    const dto = plainToInstance(AdminRejectApplicationDto, { reason: '   ' });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });
});
