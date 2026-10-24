/**
 * @fileoverview Zernio TikTok Messaging Provider
 *
 * DMs do TikTok pela Zernio. A API é a mesma do Instagram (Bearer único,
 * envio para o *conversation id* da Zernio com o `accountId` da conta), então
 * este provider só muda o tipo do canal: a Factory indexa por
 * `channelType/provider`, e `tiktok/zernio` precisa existir para o
 * channel-router instanciar o envio de um canal TikTok.
 *
 * O retry com HUMAN_AGENT herdado é inofensivo aqui: o TikTok ignora a tag e
 * a segunda tentativa só repete o erro original.
 *
 * @module lib/messaging/providers/tiktok/zernio
 */

import { ZernioInstagramProvider } from '../instagram/zernio.provider';
import type { ChannelType } from '../../types';

export class ZernioTiktokProvider extends ZernioInstagramProvider {
  override readonly channelType: ChannelType = 'tiktok';
}

export default ZernioTiktokProvider;
