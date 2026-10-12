import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { DEVICE_KINDS, type DeviceKind } from '../devices.types';

export class ListDevicesQueryDto {
  @ApiProperty({ enum: DEVICE_KINDS })
  @IsIn(DEVICE_KINDS)
  kind!: DeviceKind;
}
