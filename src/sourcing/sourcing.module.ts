import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { HttpMouserApi, MouserApi } from './mouser-api';
import { SourcingController } from './sourcing.controller';
import { SourcingRepository } from './sourcing.repository';
import { SourcingService } from './sourcing.service';

@Module({
  imports: [ProjectsModule],
  controllers: [SourcingController],
  providers: [{ provide: MouserApi, useClass: HttpMouserApi }, SourcingRepository, SourcingService],
  exports: [SourcingService],
})
export class SourcingModule {}
