import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';

import {
  LibraryCheckDto,
  LibraryRenderDto,
  SaveLibraryLayoutDto,
} from '../dto/schematic.dto';
import { DevLayoutService } from './dev-layout.service';
import { LayoutToolGuard } from './layout-tool.guard';

/**
 * DEV-LAYOUT: developer layout tool (temporary; remove before the public
 * release). Only where `SCHEMATIC_LAYOUT_TOOL` is on; 404 elsewhere.
 */
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(LayoutToolGuard)
@Controller('dev/schematic')
export class DevLayoutController {
  constructor(private readonly dev: DevLayoutService) {}

  @Get('library-status')
  status() {
    return { topologies: this.dev.status() };
  }

  @Post('render')
  @HttpCode(HttpStatus.OK)
  render(@Body() dto: LibraryRenderDto) {
    return this.dev.render(dto.topologyId, dto);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  check(@Body() dto: LibraryCheckDto) {
    return this.dev.check(
      dto.topologyId,
      dto.schematic,
      dto.sheet ?? null,
      dto.layout,
    );
  }

  @Post('library-layout')
  @HttpCode(HttpStatus.OK)
  save(@Body() dto: SaveLibraryLayoutDto) {
    return this.dev.save(dto.topologyId, dto.layout, dto.tuned !== false);
  }
}
