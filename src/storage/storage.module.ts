import { Global, Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { ObjectStore } from './object-store';
import { S3ObjectStore } from './s3-object-store';
import { StorageSweeperService } from './storage-sweeper.service';
import { StoredFilesRepository } from './stored-files.repository';
import { StoredFilesService } from './stored-files.service';

/**
 * Private S3 storage behind CloudFront. Global so any feature module can
 * store uploads, stage payloads and exports. Tests override `ObjectStore`.
 */
@Global()
@Module({
  controllers: [FilesController],
  providers: [
    { provide: ObjectStore, useClass: S3ObjectStore },
    StoredFilesRepository,
    StoredFilesService,
    StorageSweeperService,
  ],
  exports: [StoredFilesService, StorageSweeperService],
})
export class StorageModule {}
