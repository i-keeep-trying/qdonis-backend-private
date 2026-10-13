import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/enums';
import { AdminProjectsQueryDto } from './dto/project.dto';
import { ProjectsService } from './projects.service';

/**
 * Admin panel: every project. Opening one goes through `GET /projects/:id`,
 * where platform administrators get read-only (VIEWER) access.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/projects')
export class AdminProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({
    summary: 'All projects with their owner (search by name or owner email)',
  })
  list(@Query() query: AdminProjectsQueryDto) {
    return this.projects.adminList(query);
  }
}
