import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Role } from '../generated/prisma/enums';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * User administration (ADMIN only). Self-service lives in `MeController`,
 * which is registered first so `/users/me` never reaches `/users/:id`.
 */
@ApiTags('users (admin)')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a user' })
  @ApiCreatedResponse({ type: UserEntity })
  @ApiConflictResponse({ description: 'EMAIL_TAKEN' })
  create(@Body() dto: CreateUserDto): Promise<UserEntity> {
    return this.usersService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List users' })
  @ApiOkResponse({ type: PaginatedResultDto })
  findAll(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<UserEntity>> {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single user' })
  @ApiOkResponse({ type: UserEntity })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserEntity> {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a user',
    description:
      'Deactivation or a role change revokes the user’s sessions. Admins cannot change their own role or status, and the last active admin cannot be removed.',
  })
  @ApiOkResponse({ type: UserEntity })
  @ApiConflictResponse({
    description: 'EMAIL_TAKEN | SELF_MODIFICATION | LAST_ADMIN',
  })
  update(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserEntity> {
    return this.usersService.update(actorId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a user (sessions, tokens and Google links cascade)',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'SELF_MODIFICATION | LAST_ADMIN' })
  remove(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.usersService.remove(actorId, id);
  }
}
