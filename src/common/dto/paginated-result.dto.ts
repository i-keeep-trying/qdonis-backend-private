import { ApiProperty } from '@nestjs/swagger';

/**
 * Envelope for paginated list endpoints.
 *
 * Lists are the one place a wrapper is unavoidable, because `total` cannot be
 * expressed inside a bare array.
 */
export class PaginatedResultDto<T> {
  @ApiProperty({ description: 'The records for the requested page' })
  items: T[];

  @ApiProperty({ description: 'Total number of records matching the query' })
  total: number;

  @ApiProperty({ description: 'Records skipped to reach this page' })
  skip: number;

  @ApiProperty({ description: 'Maximum records requested for this page' })
  take: number;

  constructor(items: T[], total: number, skip: number, take: number) {
    this.items = items;
    this.total = total;
    this.skip = skip;
    this.take = take;
  }
}
