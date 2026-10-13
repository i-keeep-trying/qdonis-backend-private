import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { TopologiesService } from './topologies.service';
import type { TopologyLibraryEntry } from './topologies.types';

@ApiTags('topologies')
@ApiBearerAuth()
@Controller('topologies')
export class TopologiesController {
  constructor(private readonly topologies: TopologiesService) {}

  @Get()
  @ApiOperation({ summary: 'The built-in topology library' })
  @ApiOkResponse({ description: '`[{ id, title, family }]`, sorted by id' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  list(): TopologyLibraryEntry[] {
    return this.topologies.library();
  }
}
