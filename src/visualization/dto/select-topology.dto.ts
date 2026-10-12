import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of `POST /projects/:projectId/branches/:branchId/stages/visualization`. */
export class SelectTopologyDto {
  @ApiProperty({ example: 'dcdc_buck', maxLength: 256 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  topologyId!: string;
}
