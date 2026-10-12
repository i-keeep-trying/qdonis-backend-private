import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CircuitInfoService } from './circuit-info.service';
import { CircuitInfoDto } from './dto/circuit-info.dto';

@ApiTags('circuits')
@ApiBearerAuth()
@Controller('studio')
export class CircuitsController {
  constructor(private readonly circuits: CircuitInfoService) {}

  @Post('circuit-info')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Inventory of a topology (or an edited circuit) with design values applied',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiNotFoundResponse({ description: 'TOPOLOGY_NOT_FOUND' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  circuitInfo(@Body() dto: CircuitInfoDto) {
    return {
      success: true,
      inventory: this.circuits.inventory({
        topologyId: dto.topology_id,
        circuit: dto.circuit,
        recalculated: dto.recalculated_parameters,
      }),
    };
  }
}
