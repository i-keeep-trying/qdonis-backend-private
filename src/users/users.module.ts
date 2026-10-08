import { Module } from '@nestjs/common';

import { SessionsModule } from '../auth/sessions/sessions.module';
import { MeController } from './me.controller';
import { PasswordHasher } from './password-hasher.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [SessionsModule],
  // Order matters: `users/me` must be registered before `users/:id`.
  controllers: [MeController, UsersController],
  providers: [UsersService, UsersRepository, PasswordHasher],
  exports: [UsersService, PasswordHasher],
})
export class UsersModule {}
