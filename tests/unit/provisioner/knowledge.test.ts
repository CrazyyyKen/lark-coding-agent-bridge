import { describe, expect, it } from 'vitest';
import { checkKnowledge, lines, probeFor } from '../../../src/provisioner/knowledge';
import type { RequestRecord } from '../../../src/provisioner/base-store';

const host = 'https://gdexgroup.sg.larksuite.com';

describe('probeFor', () => {
  it('maps each kind of Lark link to a read-only call', () => {
    expect(probeFor(`${host}/docx/AbCdEf123456?from=x`)).toEqual({ path: '/open-apis/docx/v1/documents/AbCdEf123456' });
    expect(probeFor(`${host}/wiki/NYRWwPSsYirbBokuOhBlAROzghe?from=from_copylink`)).toEqual({
      path: '/open-apis/wiki/v2/spaces/get_node',
      params: { token: 'NYRWwPSsYirbBokuOhBlAROzghe' },
    });
    expect(probeFor(`${host}/wiki/settings/7311234567890123`)).toEqual({ path: '/open-apis/wiki/v2/spaces/7311234567890123' });
    expect(probeFor(`${host}/base/Ej2rbuVelaxD7xsLa4EllBP6gph?table=tbl1`)).toEqual({
      path: '/open-apis/bitable/v1/apps/Ej2rbuVelaxD7xsLa4EllBP6gph',
    });
    expect(probeFor(`${host}/sheets/ShtAbc123456`)).toEqual({ path: '/open-apis/sheets/v3/spreadsheets/ShtAbc123456' });
    expect(probeFor(`${host}/drive/folder/FldAbc123456`)).toEqual({
      path: '/open-apis/drive/v1/files',
      params: { folder_token: 'FldAbc123456', page_size: 1 },
    });
    expect(probeFor('The HR handbook')).toBeUndefined();
  });

  it('splits free-text answers into lines and drops bullets', () => {
    expect(lines(' - a\r\n\n• b \n* c')).toEqual(['a', 'b', 'c']);
  });
});

describe('checkKnowledge', () => {
  it('reports each listed item as reachable, not reachable or not checkable', async () => {
    const req = {
      documents: `${host}/docx/Readable123\n${host}/docx/Locked123456\nSome handbook`,
      wikiPages: `${host}/wiki/WikiNode123456`,
      groupChats: 'HR Team\nhttps://applink.larksuite.com/client/chat/open?openChatId=oc_abc123',
    } as RequestRecord;
    const items = await checkKnowledge(req, async (path) => {
      if (path.endsWith('Readable123') || path.includes('get_node')) return { ok: true };
      if (path === '/open-apis/im/v1/chats') return { ok: true, data: { items: [{ chat_id: 'oc_abc123', name: 'Other' }] } };
      return { ok: false };
    });
    expect(items.map((i) => [i.kind, i.ok])).toEqual([
      ['document', true],
      ['document', false],
      ['document', undefined],
      ['wiki', true],
      ['group', false],
      ['group', true],
    ]);
  });
});
