import type { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import type { MouserApi, MouserCall } from './mouser-api';
import type { SourcingRepository } from './sourcing.repository';
import { SourcingService } from './sourcing.service';

type Part = {
  ManufacturerPartNumber: string;
  MouserPartNumber: string;
  Availability: string;
  Price: string;
};

/** A service whose Mouser part-number search answers with `parts`. */
function serviceAnswering(parts: Part[]) {
  const requests: unknown[] = [];
  const api = {
    configured: () => true,
    partNumber: (body: unknown): Promise<MouserCall> => {
      requests.push(body);
      return Promise.resolve({
        endpoint: '/search/partnumber',
        statusCode: 200,
        durationMs: 1,
        results: parts.length,
        error: null,
        response: {
          Errors: [],
          SearchResults: {
            NumberOfResult: parts.length,
            Parts: parts.map((p) => ({
              Manufacturer: 'Wolfspeed',
              ManufacturerPartNumber: p.ManufacturerPartNumber,
              MouserPartNumber: p.MouserPartNumber,
              Availability: p.Availability,
              Description: 'SiC MOSFET',
              ProductAttributes: [],
              PriceBreaks: [{ Quantity: 1, Price: p.Price, Currency: 'GBP' }],
            })),
          },
        },
      } as unknown as MouserCall);
    },
  } as unknown as MouserApi;
  const repository = {
    callsSince: () => Promise.resolve(0),
    logCall: () => Promise.resolve(),
  } as unknown as SourcingRepository;
  const config = {
    get: () => ({ callsPerMinute: 100, callsPerDay: 1000 }),
  } as unknown as ConfigService<AppConfiguration, true>;
  return { service: new SourcingService(api, repository, config), requests };
}

const ctx = { userId: 'u1', projectId: 'p1' };

describe('SourcingService.exactPart', () => {
  it('takes the reel packaging when Mouser lists only that (E4M0045075J2 -> -TR)', async () => {
    const { service, requests } = serviceAnswering([
      {
        ManufacturerPartNumber: 'E4M0045075J2-TR',
        MouserPartNumber: '941-E4M0045075J2-TR',
        Availability: '674 In Stock',
        Price: '£8.97',
      },
    ]);
    const part = await service.exactPart(ctx, 'E4M0045075J2');
    expect(part?.mouserPartNumber).toBe('941-E4M0045075J2-TR');
    expect(requests).toEqual([
      {
        SearchByPartRequest: {
          mouserPartNumber: 'E4M0045075J2',
          partSearchOptions: 'BeginsWith',
        },
      },
    ]);
  });

  it('prefers the exact number and ignores longer part numbers', async () => {
    const { service } = serviceAnswering([
      {
        ManufacturerPartNumber: 'C3M0045065J1-TR',
        MouserPartNumber: '941-C3M0045065J1-TR',
        Availability: '10 In Stock',
        Price: '£8.03',
      },
      {
        ManufacturerPartNumber: 'C3M0045065J1',
        MouserPartNumber: '941-C3M0045065J1',
        Availability: '10 In Stock',
        Price: '£8.03',
      },
    ]);
    expect(
      (await service.exactPart(ctx, 'C3M0045065J1'))?.mouserPartNumber,
    ).toBe('941-C3M0045065J1');

    const other = serviceAnswering([
      {
        ManufacturerPartNumber: 'C3D10065A2',
        MouserPartNumber: '941-C3D10065A2',
        Availability: '1 In Stock',
        Price: '£1.00',
      },
      {
        ManufacturerPartNumber: 'C3D10065A-BOARD',
        MouserPartNumber: '941-X',
        Availability: '1 In Stock',
        Price: '£1.00',
      },
    ]);
    expect(await other.service.exactPart(ctx, 'C3D10065A')).toBeNull();
  });
});
