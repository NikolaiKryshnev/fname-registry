import { Kysely, Selectable } from 'kysely';
import { Database, TransfersTable } from './db.js';
import { ADMIN_KEYS, generateSignature, signer, verifySignature } from './signature.js';
import { bytesToHex, hexToBytes } from './util.js';
import { currentTimestamp } from './util.js';
import { bytesCompare, validations } from '@farcaster/hub-nodejs';

const PAGE_SIZE = 100;
const TIMESTAMP_TOLERANCE = 60; // 1 minute

type TransferRequest = {
  timestamp: number;
  username: string;
  owner: string;
  from: number;
  to: number;
  userSignature: string;
  userFid: number;
};

export type TransferHistoryFilter = {
  fromTs?: number;
  fromId?: number;
  name?: string;
  fid?: number;
};

type ErrorCode =
  | 'USERNAME_TAKEN'
  | 'TOO_MANY_NAMES'
  | 'UNAUTHORIZED'
  | 'USERNAME_NOT_FOUND'
  | 'INVALID_SIGNATURE'
  | 'INVALID_USERNAME'
  | 'INVALID_TIMESTAMP';
export class ValidationError extends Error {
  public readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(`Validation error: ${code}`);
    this.code = code;
  }
}

export async function createTransfer(req: TransferRequest, db: Kysely<Database>) {
  const existing_matching_transfer_id = await validateTransfer(req, db);
  if (existing_matching_transfer_id) {
    return { id: existing_matching_transfer_id };
  }
  const serverSignature = await generateSignature(req.username, req.timestamp, req.owner, signer);
  const transfer = {
    ...req,
    serverSignature,
    owner: hexToBytes(req.owner),
    userSignature: hexToBytes(req.userSignature),
  };
  return await db.insertInto('transfers').values(transfer).returning('id').executeTakeFirst();
}

export async function validateTransfer(req: TransferRequest, db: Kysely<Database>) {
  const verifierAddress = ADMIN_KEYS[req.userFid];
  if (!verifierAddress) {
    // Only admin transfers are allowed until we finish migrating
    throw new ValidationError('UNAUTHORIZED');
  }

  if (!verifySignature(req.username, req.timestamp, req.owner, req.userSignature, verifierAddress)) {
    throw new ValidationError('INVALID_SIGNATURE');
  }

  const validationResult = validations.validateFname(req.username);
  if (validationResult.isErr()) {
    throw new ValidationError('INVALID_USERNAME');
  }

  const existingTransfer = await getLatestTransfer(req.username, db);

  const existingName = await getCurrentUsername(req.to, db);
  if (existingName) {
    if (
      existingTransfer &&
      existingName === req.username &&
      bytesCompare(hexToBytes(existingTransfer.owner), hexToBytes(req.owner)) === 0
    ) {
      return existingTransfer.id;
    }
    throw new ValidationError('TOO_MANY_NAMES');
  }

  if (req.timestamp > currentTimestamp() + TIMESTAMP_TOLERANCE) {
    throw new ValidationError('INVALID_TIMESTAMP');
  }

  if (existingTransfer && existingTransfer.timestamp > req.timestamp) {
    throw new ValidationError('INVALID_TIMESTAMP');
  }

  if (req.from === 0) {
    // Mint
    if (existingTransfer && existingTransfer.to !== 0) {
      throw new ValidationError('USERNAME_TAKEN');
    }
  } else if (req.to === 0) {
    // Burn
    if (!existingTransfer || existingTransfer.to === 0) {
      throw new ValidationError('USERNAME_NOT_FOUND');
    }
  } else {
    // Transfer
    if (!existingTransfer) {
      throw new ValidationError('USERNAME_NOT_FOUND');
    }
  }
}

export async function getLatestTransfer(name: string, db: Kysely<Database>) {
  return toTransferResponse(
    await db
      .selectFrom('transfers')
      .selectAll()
      .where('username', '=', name)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .executeTakeFirst()
  );
}

export async function getCurrentUsername(fid: number, db: Kysely<Database>) {
  // fid 0 is the mint/burn address, so it can never have a username
  if (fid === 0) {
    return undefined;
  }
  // To get the current username, we need to get the most recent transfer and ensure the fid is the receiver
  const transfer = await db
    .selectFrom('transfers')
    .select(['username', 'from', 'to'])
    .where(({ or, cmpr }) => {
      return or([cmpr('from', '=', fid), cmpr('to', '=', fid)]);
    })
    .orderBy('timestamp', 'desc')
    .limit(1)
    .executeTakeFirst();

  // The most recent transfer to the fid is the current username. We have validations that ensure there can only be
  // one name per fid
  if (transfer && transfer.to === fid) {
    return transfer.username;
  } else {
    return undefined;
  }
}

function toTransferResponse(row: Selectable<TransfersTable> | undefined) {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    username: row.username,
    owner: bytesToHex(row.owner),
    from: row.from,
    to: row.to,
    user_signature: bytesToHex(row.userSignature),
    server_signature: bytesToHex(row.serverSignature),
  };
}

export async function getTransferById(id: number, db: Kysely<Database>) {
  const row = await db.selectFrom('transfers').selectAll().where('id', '=', id).executeTakeFirst();
  return toTransferResponse(row);
}

export async function getTransferHistory(filterOpts: TransferHistoryFilter, db: Kysely<Database>) {
  let query = db.selectFrom('transfers').selectAll();
  if (filterOpts.fromId) {
    query = query.where('id', '>', filterOpts.fromId);
  }
  if (filterOpts.fromTs) {
    query = query.where('timestamp', '>', filterOpts.fromTs);
  }
  if (filterOpts.name) {
    query = query.where('username', '=', filterOpts.name);
  }
  if (filterOpts.fid) {
    const _fid = filterOpts.fid;
    query = query.where(({ or, cmpr }) => {
      return or([cmpr('from', '=', _fid), cmpr('to', '=', _fid)]);
    });
  }

  // If we're filtering by timestamp, we need to order by timestamp first because clients may use that as the high watermark
  if (filterOpts.fromTs) {
    query = query.orderBy('timestamp');
  }

  const res = await query.orderBy('id').limit(PAGE_SIZE).execute();
  return res.map(toTransferResponse);
}
