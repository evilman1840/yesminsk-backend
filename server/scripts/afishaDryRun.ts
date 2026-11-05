// Проверка афиши без базы: читает каналы и (если есть ANTHROPIC_API_KEY) показывает, как Haiku разобрал посты.
// npx ts-node --transpile-only scripts/afishaDryRun.ts [сколько постов на канал]
import 'dotenv/config';
import { fetchChannelPosts, parsePost } from '../src/afisha';

(async () => {
  const limit = Number(process.argv[2]) || 3;
  for (const channel of (process.env.AFISHA_CHANNELS || 'minsk_kuda,Minsk_kudaGo').split(',')) {
    const posts = await fetchChannelPosts(channel.trim());
    console.log(`\n=== @${channel}: ${posts.length} постов, последний ${posts.at(-1)?.postedAt.toISOString()}`);
    for (const p of posts.slice(-limit)) {
      console.log(`\n--- ${p.url} ${p.photoUrl ? '📷' : ''}\n${p.text.slice(0, 120).replace(/\n/g, ' ')}…`);
      if (process.env.ANTHROPIC_API_KEY) console.log(await parsePost(p));
    }
  }
})();
