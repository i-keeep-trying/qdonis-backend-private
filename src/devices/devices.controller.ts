import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { DevicesService } from './devices.service';
import { ListDevicesQueryDto } from './dto/list-devices.dto';

@ApiTags('devices')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'Device models of one kind (mosfet, diode, igbt)' })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED (unknown kind)' })
  list(@Query() query: ListDevicesQueryDto) {
    return { success: true, models: this.devices.models(query.kind) };
  }

  @Get('catalogue')
  @ApiOperation({
    summary:
      'Usable parts with ratings (no diode-less MOSFETs, no body diodes)',
  })
  catalogue() {
    return { success: true, parts: this.devices.catalogue() };
  }
}
