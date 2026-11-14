/**
 * Тексты бота для новых функций: шаблоны сходок, «Хочу сходить», приветственный толчок.
 * Правила: на «ты», нейтрально по роду, без длинных тире
 */

export const TEMPLATE_TEXTS = {
  // /templates: подпись к таблице
  csvCaption:
    '🧩 <b>Шаблоны сходок.</b> Поправь и пришли файл обратно. Пустая ячейка ничего не меняет.\n\n' +
    'Ключ: латиницей, по нему шаблон и находится (новый ключ = новый шаблон).\n' +
    'Вкл и Платно: да / нет. Категория: Кафе, Бар, Ресторан, Выставка, Музей, Кино, Прогулка, За город, Настолки, Спорт/вело, Поныть, Своя идея.\n' +
    'Метки и типы мест: через «;». Длительность: в часах, например 1,5.\n' +
    'В названии и описании можно писать {фильм}, {спорт}, {уровень}: подставится из доп. полей.\n' +
    'Желание: как бот скажет в «Хочу сходить», например «в кино» или «поиграть в {спорт}». Пусто: шаблона нет среди желаний.\n' +
    'Доп. поля (JSON) лучше не трогать без нужды.',
  fileName: 'Шаблоны сходок.csv',
  summaryTitle: '🧩 <b>Таблица шаблонов</b>',
  willCreate: (n: number, names: string) => `➕ Добавлю: ${n}: ${names}`,
  willUpdate: (n: number, names: string) => `✏️ Обновлю: ${n}: ${names}`,
  cantDo: '❌ <b>Не получится:</b>',
  notice: '⚠️ <b>Обрати внимание:</b>',
  nothing: 'Менять нечего.',
  applyBtn: '✅ Загрузить',
  cancelBtn: '❌ Отмена',
  cancelled: 'Отменено, ничего не менял.',
  expired: 'Таблица устарела, пришли файл ещё раз.',
  done: (created: number, updated: number) => `✅ Шаблоны обновлены: добавлено ${created}, изменено ${updated}. В приложении уже видно.`,
  // Ошибки и предупреждения по строкам
  noKey: (row: number) => `Строка ${row}: нет ключа`,
  badKey: (key: string) => `«${key}»: ключ только латиницей, цифрами и _`,
  needName: (key: string) => `«${key}»: для нового шаблона нужно «Название карточки»`,
  badCategory: (key: string, v: string) => `«${key}»: не знаю категорию «${v}»`,
  badTag: (key: string, v: string) => `«${key}»: не знаю метку «${v}»`,
  badType: (key: string, v: string) => `«${key}»: тип места «${v}» не из списка, шаблон для него не покажется`,
  badNumber: (key: string, col: string, v: string) => `«${key}»: «${col}» = «${v}», нужно число`,
  badJson: (key: string) => `«${key}»: доп. поля не читаются (JSON с ошибкой), оставил прежние`,
  unknownToken: (key: string, token: string) => `«${key}»: {${token}} есть в тексте, но такого доп. поля нет`
};

// Ошибки при создании сходки по шаблону (видит пользователь в форме)
export const MEETUP_ERRORS = {
  required: (label: string) => `Заполни поле «${label}»`,
  badOption: (label: string) => `В поле «${label}» нет такого варианта`,
  badAmount: 'Сумма: просто число, например 15'
};

// Раздел /stats про шаблоны сходок и форму
export const METRICS_TEXTS = {
  title: '🧩 <b>Сборка сходок за 30 дней</b>',
  created: (viaTemplate: number, custom: number, noTemplate: number) =>
    `Создано по шаблонам ${viaTemplate} · через «Свою идею» ${custom}${noTemplate ? ` · по старой форме ${noTemplate}` : ''}`,
  top: (list: string) => `Чаще выбирают: ${list}`,
  funnel: (opened: number, picked: number, published: number, rate: string, removed: number) =>
    `Форма: открыли ${opened} → выбрали идею ${picked} → опубликовали ${published} (${rate})${removed ? ` · потом удалили не меньше ${removed}` : ''}`,
  quit: (atPick: number, atForm: number) => `Бросили: на выборе идеи ${atPick} · в заполненной форме ${atForm}`,
  sources: (list: string) => `Откуда открывают: ${list}`,
  sourceNames: { feed: 'лента', empty: 'пустая лента', place: 'карточка места', link: 'ссылка', map: 'призыв на карте', people: '«Тоже хотят»', buddy: '«Пойдём вместе»', repeat: '«Повторить»', hosts: '«Организаторы месяца»' } as Record<string, string>,
  quitFields: (list: string, filled: number) => `Бросили форму, не заполнив: ${list || 'всё было заполнено'}${list && filled ? ` · всё заполнено, но ушли: ${filled}` : ''}`,
  errors: (list: string) => `Ошибки в форме: ${list}`,
  fieldNames: { title: 'название', description: 'описание', place: 'место', time: 'время', templateField: 'поле шаблона' } as Record<string, string>,
  errorNames: {
    required: 'не всё заполнено',
    geocode: 'адрес не нашёлся',
    templateField: 'поле шаблона',
    photoWait: 'ждали фото',
    customCategory: 'своя идея без названия',
    server: 'ошибка сервера'
  } as Record<string, string>
};

// Загрузка фото сходок и анкет
export const PHOTO_TEXTS = {
  notConfigured: 'Фото пока нельзя загрузить, попробуй чуть позже',
  tooMany: 'Слишком много фото за час, попробуй позже',
  badFile: 'Это не похоже на фото: подойдут JPG, PNG или WebP',
  tooBig: 'Фото слишком большое, выбери другое',
  failed: 'Не получилось сохранить фото, попробуй ещё раз'
};

// Цена сходки: бесплатно, кассе или кафе (билет, чек на месте) или организатору (фикс или донат)
const byn = (n: number) => `${String(n).replace('.', ',')} BYN`;
type PriceEv = { isPaid?: boolean; price?: number; payTo?: string; donation?: boolean; payFor?: string };
export const PRICE_TEXTS = {
  free: '💚 Бесплатно',
  venue: '🎟 Билет или чек на месте',
  venueAmount: (n: number) => `🎟 Билет или чек на месте, ~${byn(n)}`,
  host: '🙋 Платят организатору',
  hostAmount: (n: number) => `🙋 Организатору ${byn(n)}`,
  donation: '🙋 Донат организатору, сколько не жалко',
  donationAmount: (n: number) => `🙋 Донат организатору, обычно ${byn(n)}`,
  freeShort: 'бесплатно',
  venueShort: 'на месте',
  hostShort: 'организатору',
  donationShort: 'донат'
};

export const priceLabel = (ev: PriceEv) => {
  if (!ev.isPaid) return PRICE_TEXTS.free;
  const base =
    ev.payTo !== 'host'
      ? ev.price ? PRICE_TEXTS.venueAmount(ev.price) : PRICE_TEXTS.venue
      : ev.donation
        ? ev.price ? PRICE_TEXTS.donationAmount(ev.price) : PRICE_TEXTS.donation
        : ev.price ? PRICE_TEXTS.hostAmount(ev.price) : PRICE_TEXTS.host;
  return ev.payTo === 'host' && ev.payFor ? `${base} (${ev.payFor})` : base;
};
export const priceShort = (ev: PriceEv) => {
  if (!ev.isPaid) return PRICE_TEXTS.freeShort;
  const kind = ev.payTo !== 'host' ? PRICE_TEXTS.venueShort : ev.donation ? PRICE_TEXTS.donationShort : PRICE_TEXTS.hostShort;
  return ev.price ? `${kind} ~${byn(ev.price)}` : kind;
};

// «Хочу сходить»
const people = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человек' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'человека' : 'человек'}`;

export const WISH_TEXTS = {
  // Собрали сходку из шторки «Тоже хотят» — тем, у кого такое же желание на это время
  kindMeetup: (what: string, title: string, when: string, where: string) =>
    `🙋 Ты хотел(а) ${what}, и как раз собрали сходку!\n\n<b>${title}</b>\n🕒 ${when}\n📍 ${where}\n\nЗагляни: если подходит, запишись 🙂`,
  kindMeetupBtn: 'Открыть сходку',
  // «Позвать в компанию»: организатор отметил тебя в «Тоже хотят»
  invite: (name: string, title: string, when: string, where: string) =>
    `👋 ${name} зовёт тебя в компанию: вы оба хотели сходить, и ${name} собрал(а) сходку!\n\n<b>${title}</b>\n🕒 ${when}\n📍 ${where}\n\nЕсли подходит, запишись 🙂`,
  inviteBtn: 'Посмотреть и записаться',
  when: { today: 'сегодня', tomorrow: 'завтра', weekend: 'на выходных', week: 'на неделе' } as Record<string, string>,
  // Сообщение о совпадении (одно или несколько желаний сразу)
  matchOne: (n: number, what: string, when: string) =>
    `🙋 Вас уже ${n}, кто хочет ${what} ${when}!\n\nМожет, соберёте сходку? Это займёт минуту: шаблон уже готов, останется выбрать время и место.`,
  matchManyTitle: '🙋 Нашлись люди с такими же желаниями!',
  matchManyLine: (n: number, what: string, when: string) => `• ${what} ${when}: вас уже ${n}`,
  matchManyEnd: 'Может, соберёте сходку? Это займёт минуту: шаблон уже готов, останется выбрать время и место.',
  buildBtn: 'Соберу я',
  buildBtnFor: (what: string) => `Соберу я: ${what}`,
  waitBtn: 'Пойду, если кто-то соберёт',
  whoBtn: '👀 Кто ещё хочет',
  whoBtnFor: (what: string) => `👀 Кто ещё хочет ${what}`,
  cancelBtn: 'Уже не актуально',
  waitOk: 'Хорошо! Как только кто-то соберёт сходку, бот пришлёт ссылку 🙌',
  cancelOk: 'Убрали это желание. Можно отметить новое в «Сходках» 🙂',
  // Кто-то собрал сходку
  built: (title: string, when: string, where: string) => `🎉 Сходку собрали: ${title}, ${when}, ${where}. Записаться можно тут 👇`,
  builtBtn: 'Пойду!',
  // Через сутки, если никто не собрал
  reminder: (what: string, when: string) => `Пока никто не собрал сходку ${what} ${when}. Если хочется, нажми «Соберу я», остальные уже готовы 🙂`,
  // Ссылка из поста: t.me/<бот>?start=wish_cinema_weekend
  linkAsk: (what: string, when: string) => `🙋 Хочешь ${what} ${when}?\n\nОтметь желание: как только найдутся ещё люди, бот вас познакомит с идеей сходки.`,
  linkBtn: '✅ Хочу!',
  linkBad: 'Ссылка устарела 🙂 Отметить, куда хочется, можно в приложении, в «Сходках».',
  created: 'Готово! Как только найдутся ещё люди с таким же желанием, бот вас познакомит с идеей сходки 🙌',
  sameCount: (n: number) => `Ещё ${people(n)} ${n === 1 ? 'хочет' : 'хотят'} то же самое.`,
  openApp: 'Открыть «ГУЛЯЙ!»',
  // Ошибки
  tooMany: (max: number) => `Можно держать не больше ${max} желаний сразу. Убери одно из старых.`,
  badKind: 'Такого варианта нет',
  badCustom: 'Напиши, чего хочется: от 2 до 40 букв, например «караоке»',
  duplicate: 'Такое желание уже отмечено 🙂',
  // /stats
  statsTitle: '🙋 <b>«Хочу сходить» за 30 дней</b>',
  statsCreated: (n: number, list: string) => `Желаний: ${n}${list ? ` (${list})` : ''}`,
  statsGroups: (groups: number, built: number, rate: string, deleted: number) =>
    `Совпало групп: ${groups} · из них собрали сходку: ${built} (${rate})${deleted ? ` · ещё ${deleted} собрали, но сходку потом удалили` : ''}`,
  // Где застревают открытые группы сейчас
  statsFunnel: (waitPeople: number, waitPlace: number, proposed: number, best: string, expired: number) =>
    `Сейчас в группах: ждут людей ${waitPeople} · ждут место ${waitPlace} · предложено время ${proposed}${best} · истекли без сходки (30 дн.) ${expired}`,
  statsLinks: (n: number, withProfile: number) => `По ссылкам wish_: ${people(n)}, из них заполнили анкету ${withProfile}`,
  statsActive: (n: number) => `Активных желаний сейчас: ${n}`,
  statsAlone: (kind: number, time: number, place: number) =>
    `Без пары: больше никто не хочет того же ${kind} · хотят, но в другое время ${time} · в то же время, но в другом месте ${place}`
};

export const peopleCount = people;

// Приветственный толчок от бота
export const NUDGE_TEXTS = {
  // А: есть сходки в ближайшие 3 дня
  eventsTitle: 'Привет! 👋 Ближайшие сходки в Минске:',
  eventLine: (title: string, when: string) => `• ${title}, ${when}`,
  eventsEnd: 'Можно просто прийти, там рады новичкам.',
  eventsBtn: 'Посмотреть сходки',
  // Б: есть сохранённое место, которое хотят посетить и другие
  place: (place: string, n: string) =>
    `Привет! 👋 «${place}» у тебя в сохранённых. Это место хотят посетить ещё ${n}.\n\nСобери туда сходку, и бот позовёт всех, кто его сохранил.`,
  placeBuildBtn: 'Собрать сходку сюда',
  // В: ничего из этого
  simple:
    'Привет! 👋 Не нашлось подходящей сходки? Самое простое:\n\n🙋 Отметь, куда хочется: кино, кофе, настолки. Когда найдутся ещё люди с тем же желанием, бот вас сведёт.\n\nИли собери свою сходку по готовому шаблону, это минута.',
  buildBtn: 'Собрать сходку',
  // Второе сообщение, через 4 дня
  second: 'Пока тихо? В «ГУЛЯЙ!» можно ничего не организовывать. Просто отметь, куда хочется, и бот найдёт компанию 🙂',
  wishBtn: 'Хочу сходить',
  offBtn: 'Не сейчас',
  offOk: 'Хорошо, больше не будем напоминать 🙂',
  // /nudge — превью для автора
  previewNote: '<i>Так люди увидят сообщения бота: два приветственных и напоминание про анкету (оно подстроится под то, что не заполнено):</i>',
  // /stats
  statsTitle: '👋 <b>Приветственный толчок за 30 дней</b>',
  // Толчки выключены, а журнал ещё помнит прошлые отправки — чтобы цифры не читались как текущие
  statsDisabled: '<i>Сейчас выключены (вместе с напоминаниями про анкету и @username), цифры — по старым отправкам</i>',
  statsSent: (first: number, second: number) => `Отправлено: первых ${first}, вторых ${second}`,
  statsVariant: (v: string, sent: number, matured: number, acted: number) =>
    matured
      ? `${v}: ${sent} · 48 ч прошло у ${matured} → что-то сделали ${acted} из ${matured} (${Math.round((acted / matured) * 100)}%)`
      : `${v}: ${sent} · 48 ч ещё ни у кого не прошло`,
  statsOff: (n: number, rate: string) => `«Не сейчас»: ${n} (${rate})`,
  variantNames: { A: 'А (сходки)', B: 'Б (сохранённое место)', C: 'В (простой шаг)', second: 'Второе' } as Record<string, string>
};

// Разовое напоминание «заполни анкету подробнее»
export const PROFILE_NUDGE_TEXTS = {
  intro: (percent: number, missing: number) =>
    `Привет! 👋 Твоя анкета заполнена на ${percent}%. ${missing === 1 ? 'Осталась одна деталь' : 'Ещё пара деталей'}, и тебе будет проще найти своих людей и компанию:`,
  photo: '📸 своё фото: людям легче решиться написать и узнать тебя на сходке',
  bio: '✍️ пару слов о себе: так проще начать разговор',
  goals: '🎯 что тебе интересно: подсветим людей и сходки с общими интересами',
  goesWith: '🙂 как обычно ходишь: без компании, парой, компанией или с детьми',
  outro: 'Это займёт минуту 🙂',
  previewFull: '<i>Твоя анкета заполнена, тебе это напоминание не придёт. Так оно выглядит для пустой анкеты:</i>',
  button: '✏️ Заполнить анкету',
  // /stats
  statsTitle: '✏️ <b>Напоминание про анкету</b>',
  statsLine: (sent: number, filled: number, rate: string) => `Отправлено ${sent} · из них дополнили анкету ${filled} (${rate})`
};

// Удаление аккаунта
export const ACCOUNT_TEXTS = {
  bannedCantDelete: 'Аккаунт заблокирован модератором, удалить его нельзя',
  failed: 'Не получилось удалить аккаунт, попробуй ещё раз',
  eventCancelled: (title: string, when: string) =>
    `😔 <b>Сходка отменена</b>\n\n«${title}», ${when}. Организатор удалил аккаунт.\n\nЗагляни в приложение, там есть другие встречи.`,
  findOther: 'Найти другую сходку'
};

// «Хочу сходить»: бот сам предлагает время и место, сходка собирается без организатора
export const PROPOSAL_TEXTS = {
  offer: (n: number, what: string, place: string, note: string | undefined, times: string[], need: number) =>
    `🙋 Вас уже ${n}, кто хочет ${what}!\n\nМесто: <b>${place}</b>.${note ? `\n${note}` : ''}\n\nКогда удобно?\n${times.map((t) => `• ${t}`).join('\n')}\n\nНажми все варианты, которые подходят. Организовывать ничего не нужно: как только на одно время наберётся ${need} «Пойду», бот соберёт встречу и напишет всем.\n\nНе подходит ни один? Нажми «🕒 Предложить своё время».`,
  optionBtn: (when: string) => `✅ ${when}`,
  noBtn: 'Не смогу ни в один',
  // Своё время от человека из группы
  ownBtn: '🕒 Предложить своё время',
  ownAsk: (what: string) =>
    `🕒 Когда тебе удобно ${what}? Напиши день и время, например:\n• пятница 19:00\n• завтра в 18:30\n• 7.11 в 12:00\n\nЕсли передумается, напиши «отмена».`,
  ownNoTime: 'А во сколько? Напиши день и время вместе, например: «пятница 19:00».',
  ownBad: 'Не получилось разобрать 🙈 Напиши день и время, например: «пятница 19:00» или «7.11 в 18:30».',
  ownTooSoon: 'Это слишком скоро: предложи время хотя бы через 2 часа, чтобы остальные успели ответить.',
  ownTooFar: 'Это слишком далеко: предложи время в ближайшие 3 недели.',
  ownAdded: (when: string, need: number) =>
    `✅ Предложили группе: <b>${when}</b>. Ты уже в «Пойду». Как на это время наберётся ${need} «Пойду», бот соберёт встречу и напишет всем.`,
  ownExists: (when: string) => `Такой вариант уже есть: <b>${when}</b>. Записали тебя на него 🙌`,
  ownCancelled: 'Хорошо, ничего не меняем 🙂',
  ownTooMany: 'Вариантов уже много, выбери из них 🙂',
  ownLimit: 'Ты уже предложил(а) два варианта, этого хватит 🙂',
  ownNotify: (name: string, what: string, when: string, place: string) =>
    `🕒 ${name} предлагает другое время ${what}: <b>${when}</b>, место: ${place}.\n\nПодходит? Нажми «Пойду» 👇`,
  ownGoBtn: (when: string) => `✅ Пойду: ${when}`,
  whoBtn: '👀 Кто ещё хочет',
  yesOk: (count: number, need: number, when: string) => (count >= need ? '🎉 Сходка собрана!' : `Записали на ${when}! Уже ${count} из ${need} 🙌`),
  otherTime: (when: string) => `Сходку уже собрали на ${when}. Если подходит, запишись в приложении 🙂`,
  // «Не смогу ни в один» — обычным сообщением: всплывающая строка сверху почти не видна и обрезается
  noOk: 'Хорошо, понятно 🙂\n\nЕсли тебе удобно другое время, предложи его: бот спросит остальных. Или отметь новое желание, и бот подберёт другую компанию.',
  noAck: 'Понятно 🙂',
  wishBtn: '🙋 Хочу сходить',
  lateJoin: '🎉 Ты в списке! Сходка уже собрана, ждём тебя.',
  gone: 'Это предложение уже неактуально 🙂',
  // Сходка собрана
  createdForYes: (title: string, when: string, where: string) =>
    `🎉 <b>Сходка собрана!</b>\n\n${title}\n🕒 ${when}\n📍 ${where}\n\nТы в списке участников. Если планы поменяются, отмени участие в приложении.`,
  openEvent: 'Открыть сходку',
  createdForHost: (title: string, when: string, where: string) =>
    `🎉 <b>Встреча собрана, и ты её хозяин!</b>\n\n${title}\n🕒 ${when}\n📍 ${where}\n\nТвоё «Пойду» было первым. Ничего особенного делать не нужно: приди чуть раньше и займи столик. В приложении можно написать участникам или поменять детали. Если не сможешь пойти, не удаляй сходку: нажми 🗑 и передай её следующему.`,
  // Напоминание тем, кто не ответил на предложение
  remind: (n: number, what: string, when: string, place: string) =>
    n > 0
      ? `🙋 Уже ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человек идёт' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'человека идут' : 'человек идут'} ${what}: <b>${when}</b>, место: ${place}.\n\nПрисоединишься? Нажми время, которое подходит 👇`
      : `🙋 Напоминаю: собираемся ${what}, место: ${place}. Нажми время, которое подходит, и как только наберётся компания, бот всё соберёт 👇`,
  // «Пойду» нажал только один человек: предлагаем опубликовать сходку, чтобы присоединились другие
  soloAsk: (what: string, when: string, place: string, n: number) =>
    `🙋 Пока на <b>${when}</b> ${what} нажал(а) «Пойду» только ты, а в группе вас ${n}.\n\n` +
    `Давай опубликуем сходку: ${place}, ${when}. Её увидят в ленте, и остальные из группы получат сообщение. Ты будешь организатором, но делать ничего особенного не нужно: просто прийти 🙂`,
  soloYesBtn: '📣 Да, публикуй',
  soloWaitBtn: 'Подожду ещё',
  soloWaitOk: 'Хорошо, подождём ещё 🙂',
  soloDone: '🎉 Опубликовали!',
  // Все варианты времени прошли — новые
  reofferLead: '🕒 Прошлые варианты времени прошли, вот новые.',
  adminCreated: (title: string, when: string, n: number) =>
    `⭐ Из «Хочу сходить» собралась встреча: <b>${title}</b>, ${when}. Записались: ${n}.\n\nЗагляни, если сможешь 🙂`,
  adminNoPlace: (what: string, n: number) =>
    `🙋 ${n} человек хотят ${what}, но в «Местах» нет подходящего места, и предложить время с местом бот не может. Добавь место нужного типа или собери сходку сам: /wishes`,
  // /wishes — для автора
  listTitle: '🙋 <b>Группы «Хочу сходить»</b>',
  listEmpty: 'Открытых групп сейчас нет.',
  listLine: (what: string, when: string, n: number, state: string) => `• ${what} ${when}: ${n} чел. ${state}`,
  stateNone: '· предложения ещё не было',
  stateProposed: (votes: string, no: number) => `· предложено: ${votes} · ❌ ${no}`,
  proposeBtn: (what: string) => `📣 Предложить время: ${what}`,
  buildBtn: (what: string) => `🛠 Собрать самому: ${what}`,
  proposedNow: 'Предложение отправлено группе 📣',
  cantPropose: 'Не получилось предложить: нет подходящего времени в окне группы или места для этого вида.'
};

// Люди предлагают места (кофейни и т.п.): из приложения и в ответ боту
export const SUGGEST_TEXTS = {
  needLink: 'Пришли ссылку на место из Яндекс Карт: открой место → «Поделиться» → «Скопировать ссылку». Или напиши название и адрес.',
  notFound: 'Не получилось найти это место в Минске. Пришли ссылку из Яндекс Карт или напиши адрес точнее.',
  thanks: 'Спасибо! Место на проверке, скоро добавим его в «Места» 💛',
  // Автору проекта
  adminCard: (name: string, type: string, address: string, desc: string, link: string, who: string, context: string) =>
    `📍 <b>Предлагают место</b>\n\n<b>${name}</b>\n🏷 ${type || '<i>тип не выбран</i>'}${address ? `\n📍 ${address}` : ''}${desc ? `\n📝 ${desc}` : ''}${link ? `\n${link}` : ''}\n\nОт: ${who}${context ? `\n${context}` : ''}\n\nМожно поправить кнопками ниже, потом «Добавить».`,
  placeCard: (name: string, type: string, address: string, desc: string, link: string, moods: string, photos = 0, tip = '', blog = '') =>
    `✏️ <b>${name}</b>\n🏷 ${type || '<i>тип не выбран</i>'}${address ? `\n📍 ${address}` : ''}${desc ? `\n📝 ${desc}` : ''}\n🌈 ${moods || '<i>вайбы не выбраны</i>'}` +
    `\n🖼 ${photos ? `Фото: ${photos}` : '<i>фото нет</i>'}\n💡 ${tip || '<i>совета нет</i>'}\n📖 ${blog || '<i>статьи нет</i>'}${link ? `\n${link}` : ''}\n\nЧто поправить?`,
  editMoods: '🌈 Вайбы',
  editAskMoods: (name: string) => `🌈 Какие вайбы у «${name}»? Нажимай, чтобы включить или выключить, потом «Готово».`,
  moodsDone: 'Готово →',
  editName: '✏️ Название',
  editCat: '🏷 Тип',
  editAddr: '📍 Адрес',
  editDesc: '📝 Описание',
  editPhotos: '🖼 Фото',
  editTip: '💡 Совет от Миши',
  editBlog: '📖 Статья',
  editAskPhotos: (name: string, n: number, max: number) =>
    `🖼 Шли фото для «${name}», можно альбомом, до ${max} всего (сейчас ${n}). Закончить: /cancel`,
  editClearPhotos: '🗑 Убрать все фото',
  editPhotosCleared: (name: string, n: number) => `🗑 У «${name}» убраны все фото (${n}).`,
  editAskTip: (current: string) => `${current ? `Сейчас: «${current}»\n\n` : ''}💡 Пришли совет: фишку, которую знают только местные. Убрать совет: «-» (или /cancel)`,
  editAskBlog: (current: string) => `${current ? `Сейчас: ${current}\n\n` : ''}📖 Пришли ссылку на статью (https://…). Убрать ссылку: «-» (или /cancel)`,
  editBadBlog: 'Нужна ссылка, начинающаяся с https:// Убрать ссылку: «-» (или /cancel)',
  editAskName: (name: string) => `Сейчас: «${name}». Пришли новое название (или /cancel)`,
  editAskAddr: 'Пришли адрес или ссылку из Яндекс Карт (или /cancel)',
  editAskDesc: 'Пришли описание одной фразой. Убрать описание: «-» (или /cancel)',
  editAskCat: (name: string) => `Какой тип у «${name}»?`,
  editAddrNotFound: 'Не нашёл такой адрес в Минске. Пришли улицу и дом или ссылку из Яндекс Карт (или /cancel)',
  editCancelled: 'Ок, ничего не меняем.',
  editDone: 'Это предложение уже разобрано. Поправить место: /placeedit номер',
  editUsage: 'Так: <code>/placeedit номер</code> (из /places) или <code>/placeedit Зерно</code>',
  editNoPlace: 'Нет такого места. Список: /places',
  fromGroup: (what: string) => `Для группы «Хочу сходить»: ${what}`,
  approveBtn: '✅ Добавить в Места',
  rejectBtn: '❌ Нет',
  approved: (name: string, type: string) => `✅ «${name}» добавлено в «Места»${type ? ` с типом «${type}»` : ''}. Поправить можно кнопками ниже или потом: /placeedit`,
  rejected: 'Не добавляем, ок.',
  authorRejected: (name: string) => `🙏 Спасибо за «${name}»! В «Места» его пока не добавили — но присылай ещё, каждое предложение читаю.`,
  authorApproved: (name: string) => `💛 Твоё место «${name}» добавили в «Места». Спасибо, что делаешь «ГУЛЯЙ!» лучше!`,
  // Группа «Хочу сходить» без места
  groupAsk: (n: number, what: string) =>
    `🙋 Вас уже ${n}, кто хочет ${what}! Осталось выбрать место.\n\nЗнаешь, где хорошо собраться? <b>Просто отправь ответным сообщением в этот чат</b> ссылку из Яндекс Карт (место → «Поделиться» → «Скопировать») или название и адрес. Или нажми «📍 Предложить место» 👇\n\nБот сразу предложит всем это место и варианты времени.`,
  groupAskBtn: '📍 Предложить место',
  groupThanks: (name: string) => `🙌 Спасибо! Предлагаем группе «${name}» и варианты времени.`,
  groupAlready: (name: string) => `Место уже выбрали: «${name}». Смотри сообщение с вариантами времени 🙂`,
  adminAsked: (what: string, n: number) => `🙋 ${n} человек хотят ${what}, а подходящего места в «Местах» нет. Спросили группу: первая присланная ссылка станет местом сходки и придёт тебе на добавление в «Места».`
};

// «Написать участникам» — сообщение организатора через бота
export const EVENT_MESSAGE_TEXTS = {
  message: (title: string, name: string, text: string) => `📣 <b>${name}, организатор сходки «${title}»:</b>\n\n${text}`,
  replyBtn: '✉️ Ответить организатору',
  openBtn: 'Открыть сходку',
  onlyCreator: 'Писать участникам может только организатор',
  empty: 'Напиши сообщение',
  noOne: 'Пока некому писать: на сходку ещё никто не записался',
  tooMany: 'Не больше 5 сообщений в день по одной сходке',
  failed: 'Не получилось отправить, попробуй ещё раз',
  createdTip: (summary: string) =>
    `🎉 <b>Сходка опубликована</b>\n\n${summary}\n\n💡 <b>По желанию:</b> создай в Telegram групповой чат с доступом только по ссылке, ` +
    'а когда люди запишутся, нажми в карточке сходки «Написать участникам» и отправь всем приветствие и ссылку на чат. Это не обязательно, можно и без чата.',
  // Модератору: новая сходка (audience — «только девушки, 25–35 лет» или '')
  adminNew: (summary: string, author: string, audience: string) =>
    `🆕 <b>Новая сходка</b> от ${author}\n\n${summary}${audience ? `\n\n👥 Видят не все: ${audience}` : ''}`
};

// Разрешение боту писать (открыли мини-приложение по ссылке, минуя чат с ботом)
export const BOT_ACCESS_TEXTS = {
  welcome:
    '🔔 Готово! Теперь сюда будут приходить напоминания о сходках, совпадения по «Хочу сходить» и приветы 👋. Если надоест, можно выключить подборки в анкете.',
  statsLine: (can: number, total: number, blocked: number) =>
    `🔔 Бот может писать: ${can} из ${total}${blocked ? ` · не доходит: ${blocked}` : ''}${total - can - blocked > 0 ? ` · ещё неизвестно: ${total - can - blocked}` : ''}`,
  // Те, кто пользуется приложением, но пропускает совпадения и напоминания: их и стоит вернуть плашкой
  statsActiveLine: (blocked: number, never: number, active: number) =>
    `🔕 Заходили за 7 дней, но бот не пишет: ${blocked + never} из ${active} (остановили ${blocked} · не разрешали ${never})`
};

// Нет @username в Telegram: написать не получится — просим завести
export const USERNAME_TEXTS = {
  // Тому, у кого нет username, при взаимном 👋
  noUsernameMatch: (name: string, otherHasUsername: boolean) =>
    `✍️ У тебя нет имени пользователя в Telegram, поэтому ${name} не сможет написать тебе первым.\n\n` +
    (otherHasUsername ? `Напиши первым по ссылке выше 👆 или ` : '') +
    `заведи имя пользователя, это 30 секунд: Telegram → Настройки → Изменить (или нажми на своё имя) → «Имя пользователя».`,
  // Разовое напоминание в боте
  nudge:
    '✍️ <b>Заведи имя пользователя в Telegram</b>\n\n' +
    'Сейчас у тебя его нет, поэтому люди «На связи» и организаторы сходок не могут написать тебе первыми: им просто некуда нажать.\n\n' +
    'Это 30 секунд: Telegram → Настройки → Изменить (или нажми на своё имя) → «Имя пользователя». Потом открой «ГУЛЯЙ!», и мы его подхватим.',
  nudgeBtn: 'Открыть «ГУЛЯЙ!»',
  statsLine: (n: number, total: number, nudged: number, fixed: number) =>
    `✍️ Без @username: ${n} из ${total}${nudged ? ` · напомнили ${nudged} → завели ${fixed}` : ''}`
};

// Шкала донатов (/fund)
export const FUND_TEXTS = {
  usage:
    '\n\nТак: <code>/fund 95 48,45 51</code>\nПервое число: всего собрано за всё время. Второе: сколько из этого в котёл для пользователей. Третье: сколько человек уже поддержали. Второе и третье можно не писать, останутся прежними.\n' +
    'Собрано за месяц считаю сам: итог сейчас минус итог на 1-е число. Поправить итог на 1-е: <code>/fund месяц 120</code>\n/goal 500 — цель месяца',
  current: (total: string, community: string, dev: string, people: number) =>
    `💛 Собрано всего: <b>${total}</b>\n☕ Котёл для пользователей: ${community}\n🌱 На проект: ${dev}\n🧡 Поддержали: ${people} чел.`,
  month: (name: string, raised: string, goal: string, base: string) => `\n\n📅 ${name}: <b>${raised}</b> из ${goal} (итог на 1-е: ${base})`,
  savedTail: '\n\nУже видно в окне доната и в «Новостях».',
  bad: 'Не понял числа. Второе число не может быть больше первого, третье должно быть целым.',
  goalUsage: '\n\nТак: <code>/goal 500</code>, цель месяца в рублях.',
  goalCurrent: (name: string, raised: string, goal: string) => `🎯 ${name}: собрано <b>${raised}</b> из ${goal}`,
  goalSaved: (goal: string) => `✅ Цель месяца: <b>${goal}</b>. Уже видно в окне доната.`,
  goalBad: 'Не понял сумму.',
  thanksNone: 'Пока никто не разрешил сказать спасибо по имени.',
  thanksList: (n: number, list: string) => `🧡 Можно сказать спасибо по имени (${n}), новые сверху:\n\n${list}`,
  // /sent — перевод приюту или волонтёрам
  sentUsage:
    '\n\nТак: <code>/sent 15 Приют «Хвостики»</code>\nСумма и кому перевёл. В окне доната появится «Последний перевод», сумма прибавится к «передал всего».\n/delsent — удалить последнюю запись',
  sentList: (total: string, list: string) => `🐾 Передал всего: <b>${total}</b>\n\nПоследние переводы:\n${list}`,
  sentNone: '🐾 Переводов пока не записано.',
  sentSaved: (amount: string, to: string, total: string) => `✅ Записал: ${amount} → ${to}\n🐾 Передал всего: <b>${total}</b>\n\nУже видно в окне доната.`,
  sentBad: 'Не понял. Нужны сумма и кому перевёл.',
  sentDeleted: (amount: string, to: string, total: string) => `🗑 Удалил: ${amount} → ${to}\n🐾 Передал всего: <b>${total}</b>`
};

// Опрос автора (/poll в боте, шапка карты и шторка в приложении)
export const POLL_TEXTS = {
  usage:
    '\n\n<b>Новый опрос:</b>\n<code>/poll Куда направить 51% донатов? | 🐾 Приют для животных = приют | ☕ Кофе в подарок тем, кто собирает сходки = кофе | Свой вариант</code>\n' +
    '• вторая строка вопроса — пояснение под ним\n• строка «шапка: Ты в игре? 🎲» — своя подпись в шапке карты вместо «Нужен твой совет»\n• строка «кнопка: 🎲 Сыграть партию -> игры» — кнопка после голоса (вкладки: игры, люди, сходки, места, карта)\n• «= коротко» — имя для шапки после голоса: «Донаты → 🐾 приют», лучше до 12 символов (без него — первое слово)\n• «Свой вариант» — поле для своей идеи\n• отметить можно несколько вариантов\n• от 2 до 6 вариантов, прошлый опрос закроется\n\n' +
    '/pollend — закрыть и прислать итоги\n/pollcsv — таблица голосов и идей, не закрывая',
  none: 'Опроса сейчас нет.',
  bad: 'Не понял опрос: нужен вопрос до 140 символов и хотя бы 2 варианта до 60 символов через «|». Шапка — до 30 символов, кнопка — «текст -> вкладка», текст до 40 символов.',
  created: '✅ Опрос запущен: подпись в шапке карты зовёт голосовать тех, кто ещё не голосовал.\n\n',
  replaced: '\n\nПрошлый опрос закрыт.',
  ended: '🏁 Опрос закрыт, из шапки убран.\n\n',
  total: (n: number) => `Проголосовали: <b>${n}</b> (можно было отметить несколько вариантов)`,
  csvCaption: (n: number) => `Голоса и свои идеи: ${n}. Без имён.`,
  loadError: 'Не получилось загрузить опрос',
  voteError: 'Не получилось сохранить голос, попробуй ещё раз',
  closed: 'Опрос уже закончился',
  badOption: 'Такого варианта нет',
  emptyCustom: 'Напиши свой вариант'
};

// Розыгрыш кофе организаторам (/coffee)
export const COFFEE_TEXTS = {
  usage: '\n\n/coffee — розыгрыш за прошлую неделю (пн–вс)\n/coffee ещё — ещё один победитель этой недели',
  report: (period: string, hosts: number, list: string, won: string) =>
    `☕ <b>Кофе за неделю ${period}</b>\n\nОрганизаторов: ${hosts}\n${list}\n\n🏆 Победители:\n${won}`,
  drawn: '🎉 Разыграл! Напиши победителю и угости кофе.\n\n',
  already: 'Эту неделю уже разыграли.\n\n',
  noHosts: (min: number) => `На прошлой неделе не было сходок, куда записались хотя бы ${min} человека кроме организатора.`,
  noneLeft: 'Все организаторы этой недели уже выиграли.'
};

// Модерация фото (кнопки под фото в приватном канале)
export const PHOTO_MOD_TEXTS = {
  caption: (who: string) => `📷 Фото от ${who}`,
  avatarCaption: (who: string) => `🧑 Главное фото анкеты: ${who}`,
  deleteBtn: '🗑 Удалить',
  banBtn: '🚫 Удалить и заблокировать',
  deleted: '🗑 Фото удалено',
  deletedBanned: '🚫 Фото удалено, пользователь заблокирован',
  notFound: 'Фото не найдено',
  onlyAdmin: 'Только для автора проекта',
  noPhotos: 'Фото нет.',
  ownerNotice: '🗑 Одно из твоих фото удалено: оно нарушает правила «ГУЛЯЙ!». Загрузи, пожалуйста, другое.'
};

// «Люди»: подпись «почему показан» на карточке
export const PEOPLE_TEXTS = {
  sameEvent: '📅 Идёте на одну сходку',
  samePlans: (names: string) => `🙋 Тоже хочет: ${names}`
};

// «👯 Пойдём на сходку вместе»: позвать знакомого из «На связи» на сходку компанией
export const BUDDY_TEXTS = {
  // Приглашённому
  invite: (from: string, title: string, when: string, where: string, others: number) =>
    `<b>${from}</b> зовёт тебя вместе на сходку 🙌\n\n` +
    `«${title}», ${when}, ${where}\n\n` +
    (others > 0 ? `Там будет ещё ${people(others)}. Вдвоём со знакомым идти всегда проще 🙂` : 'Компания только собирается, вы будете одними из первых.'),
  yesBtn: '✅ Пойдём',
  noBtn: 'Не в этот раз',
  openBtn: 'Посмотреть сходку',
  // Приглашённый нажал «✅ Пойдём»
  joined: '🎉 Готово, ты в списке! Бот напомнит о сходке за сутки и за час.',
  requested: '📝 Заявка ушла организатору. Когда подтвердит запись, бот напишет.',
  declinedOk: 'Хорошо, может, в другой раз 🙂',
  stale: 'Это приглашение уже неактуально',
  // Отправителю
  accepted: (name: string, title: string) => `<b>${name}</b> идёт с тобой на «${title}» 🎉`,
  declined: (name: string) => `<b>${name}</b> в этот раз не сможет. Сходка в силе, может, позовёшь кого-то ещё?`,
  moreBtn: 'Позвать ещё',
  // Строка в напоминании приглашённому
  reminderLine: (name: string) => `${name} тоже идёт 👯`,
  // Ошибки для приложения
  notOpen: 'Сюда позвать не получится: сходка уже скоро, на двоих или закончилась',
  notMatch: 'Позвать можно только того, кто у тебя «На связи»',
  notFit: 'Эта сходка не подходит этому человеку по условиям организатора',
  alreadyGoing: 'Этот человек уже идёт на эту сходку',
  alreadyInvited: 'Приглашение на эту сходку этому человеку уже отправлено',
  noSeats: 'Не хватает мест, чтобы пойти вдвоём',
  limit: (n: number) => `На сегодня приглашения закончились: не больше ${n} в день. Завтра можно снова 🙂`,
  undelivered: 'Бот не может написать этому человеку: в Telegram не разрешены сообщения от бота. Позови лично 🙂',
  // /stats
  statsTitle: '👯 <b>«Пойдём вместе» за 7 дней</b>',
  statsSent: (sent: number, accepted: number, declined: number, expired: number, pending: number, undelivered: number) =>
    `Отправлено ${sent} · приняли ${accepted} · отказались ${declined} · истекли ${expired}${pending ? ` · ждут ответа ${pending}` : ''}${undelivered ? ` · не дошли ${undelivered}` : ''}`,
  statsFromMatch: (n: number, accepted: number) => `Из сообщения «Вы на связи»: отправлено ${n} · приняли ${accepted}`,
  // Сообщение «Вы на связи!»: мостик к сходке компанией (дружба, не свидание)
  matched: (name: string) => `🤝 <b>Вы на связи!</b>\n\nВы и ${name} оба хотите пообщаться. Можно написать прямо сейчас!`,
  bridgeWish: (what: string, when: string) => `🙋 Вы оба хотите ${what} ${when}. Можно сходить вместе, компанией 👯`,
  bridgeEvent: (title: string, when: string) => `📅 Вам обоим может понравиться «${title}», ${when}. Можно пойти вместе 👯`,
  bridgeAny: '👯 На сходку можно пойти вместе: компанией знакомиться проще.',
  togetherBtn: '👯 Пойдём вместе',
  profileBtn: 'Открыть анкету',
  statsCame: (came: number, first: number) => `Пришли по приглашению (сходки за 30 дней) ${came} · из них впервые на сходке ${first}`,
  statsScore: (avg: string, n: number) => `«Как прошло?» у пришедших по приглашению: ${avg} из 3 (оценок ${n})`
};

// «Помощь в наборе»: до сходки меньше 48 часов, а идут меньше трёх (recruitHelp.ts)
// Организатор уходит со своей сходки: передать следующему или удалить (eventLeave.ts)
export const EVENT_LEAVE_TEXTS = {
  notHost: 'Передать сходку может только организатор',
  started: 'Сходка уже началась, передать её не получится',
  nobody: 'Пока некому передать: кроме тебя никто не записался',
  failed: 'Не получилось передать сходку, попробуй ещё раз',
  newHost: (from: string, title: string, when: string, where: string) =>
    `🙌 <b>Теперь ты организатор</b>\n\n${from} не сможет прийти и передаёт тебе сходку «${title}», ${when}, ${where}.\n\nДелать ничего особенного не нужно: просто прийти чуть раньше. Если тоже не получается, в приложении сходку можно передать дальше или отменить.`,
  openBtn: 'Открыть сходку',
  stats: (deleted: number, withPeople: number, fromWish: number, handed: number) =>
    `🗑 Организаторы удалили до начала за 7 дней: ${deleted} (с записавшимися ${withPeople} · из «Хочу сходить» ${fromWish}) · передали другому: ${handed}`
};

export const RECRUIT_TEXTS = {
  // Тем, у кого желание «🙋 Хочу сходить» того же вида на эти дни
  wish: (what: string, title: string, when: string, where: string) =>
    `Ты хотел(а) ${what} 🙌 Есть сходка «<b>${title}</b>», ${when}, ${where}. Компания собирается, не хватает пары человек.`,
  goBtn: 'Пойду',
  skipBtn: 'Не подходит',
  joined: '🎉 Готово, ты в списке! Бот напомнит о сходке за сутки и за час.',
  requested: '📝 Заявка ушла организатору. Когда подтвердит запись, бот напишет.',
  stale: 'Эта сходка уже неактуальна',
  openBtn: 'Открыть сходку',
  // Организатору, один раз
  hostTip: (title: string, n: number) =>
    `«<b>${title}</b>»: ${n ? `пока записались ${n}` : 'пока никто не записался'}. Позови кого-то из «На связи», вдвоём заходить проще`,
  hostBtn: '👯 Позвать',
  // «Все, кто записался, пришли?» — после «Как прошло?»
  attendanceAsk: (title: string) => `Все, кто записался на «<b>${title}</b>», пришли?`,
  attendanceAll: 'Да, все',
  attendanceMark: 'Нет, отмечу',
  attendanceAllDone: (title: string) => `Все, кто записался на «${title}», пришли? Да, все ✅`,
  attendanceThanks: 'Спасибо!',
  attendanceLate: 'Отметить уже не получится: прошло больше трёх дней',
  // /stats
  statsTitle: '🆘 <b>Помощь в наборе за 7 дней</b>',
  statsHelp: (n: number, gathered: number, done: number, upcoming: number, deleted: number) =>
    `Попали в помощь: ${n} · из прошедших (${done}) набрали 3+ человека: ${gathered}${upcoming ? ` · ещё не прошли ${upcoming}` : ''}${deleted ? ` · удалены организатором ${deleted}` : ''}`,
  statsPings: (sent: number, joined: number, declined: number) => `«Компания собирается»: отправлено ${sent} · записались ${joined} · «Не подходит» ${declined}`,
  statsAttendance: (pct: string, came: number, signed: number, answered: number, asked: number) =>
    `Явка: ${pct} (пришли ${came} из ${signed}) · по сходкам, где организатор ответил «Все пришли?»: ${answered} из ${asked}`,
  statsAttendanceNone: (asked: number) => `Явка: пока никто из организаторов не ответил «Все пришли?» (спросили ${asked})`,
  statsPairs: (pairs: number, held: number) => `Прошли вдвоём (организатор и один участник): ${pairs} из ${held}`
};

// Жребий «кто пишет первым» после взаимного 👋 и шторка «✍️ Что написать» (hello.ts)
export const HELLO_TEXTS = {
  coinMe: '🪙 Монетка решила: первым пишешь ты. Не подведи',
  coinThem: (name: string) => `🪙 Монетка решила: первым пишет ${name}. Если до завтра тишина, пиши сам(а), я разрешаю`,
  helloBtn: '✍️ Что написать',
  // Через сутки тишины — второму, один раз на пару
  nudge: (name: string) => `🙈 ${name} стесняется. Напиши первым(ой)?\n\nФразу я уже придумал, осталось нажать.`,
  notMatch: 'Написать можно только тем, кто у тебя «На связи»',
  noUsername: (name: string) => `У ${name} нет @username, написать по ссылке не получится`,
  // Фразы: {общее} — из «Хочу сходить», сходок, интересов, района
  wish: (what: string, when: string) => `Привет! Вижу, ты тоже хочешь ${what} ${when}. Соберём компанию?`,
  event: (title: string, when: string) => `Привет! Идёшь на «${title}», ${when}? Давай вместе, компанией веселее`,
  area: (area: string) => `Привет! Мы оба из района «${area}». Где тут нормальный кофе?`,
  goals: {
    walk: 'Привет! Ты тоже любишь гулять)) Какое твоё любимое место в Минске?',
    cafe_bar: 'Привет! Ищу компанию на кофе. Может есть любимая кофейня?',
    expo_cinema: 'Привет! Что последнее смотрел(а) в кино или на выставке? Хочу сходить на что-нибудь компанией',
    trip_outdoors: 'Привет! Есть идея выбраться за город компанией. Ты как? или странно это?)',
    boardgames: 'Привет! Настолки это здорово. Какие нравятся?',
    sport: 'Привет! Вижу, ты за спорт. Чем занимаешься? Может, соберём компанию',
    other: 'Привет! Чем любишь заниматься в Минске? Может, сходим куда-нибудь компанией'
  } as Record<string, string>,
  universal: [
    'Привет! Монетка выбрала, кому писать первым, и вот я здесь. Куда сходим компанией?',
    'Привет! Скажи честно: кофе, прогулка или настолки?',
    'Привет! Какое место в Минске стоит показать человеку первым?',
    'Привет! Ищу компанию на выходные. Что любишь делать в городе?',
    'Привет! Может, сходим на какую-нибудь сходку вместе? Вдвоём заходить проще',
    'Привет! Я тут проверяю, работает ли «ГУЛЯЙ!». Похоже, работает 🙂 Куда пойдём?'
  ],
  // /stats
  statsTitle: '🪙 <b>Жребий «кто пишет первым» за 7 дней</b>',
  stats: (tossed: number, opened: number, pickedChosen: number, pickedOther: number, nudged: number) =>
    `Монеток брошено ${tossed} · открыли «Что написать» ${opened} · выбрали фразу: кому выпало ${pickedChosen}, второй ${pickedOther} · напоминаний через сутки ${nudged}`
};

// Партия с человеком «На связи» (games.ts, sea.ts)
export const DUEL_TEXTS = {
  invite: (name: string, game: string) => `🎲 <b>${name}</b> зовёт сыграть в ${game}.\n\nПроигравший выбирает, куда пойдёте 😏`,
  playBtn: '🎲 Играть',
  duelBtn: '🎲 Сыграть',
  five: '«Крестики-Нолики»',
  sea: '«Морской бой»',
  notMatch: 'Позвать сыграть можно только того, кто у тебя «На связи»',
  pending: 'Ты уже позвал(а) этого человека, приглашение ждёт ответа',
  pendingThem: 'Этот человек уже зовёт тебя сыграть. Загляни в «Игры» или в чат с ботом',
  statsTitle: '🎲 <b>Партии из «На связи» за 7 дней</b>',
  stats: (game: string, sent: number, accepted: number, finished: number, wrote: number) =>
    `${game}: позвали ${sent} · приняли ${accepted} · доиграли ${finished} · «Написать» после партии ${wrote}`
};

// Пол и @username перед первым 👋 (app.ts)
export const WAVE_GATE_TEXTS = {
  needGender: 'Сначала скажи, кто ты: так я правильно подберу компанию',
  needUsername: 'Без @username тебе не смогут ответить. Заведи его в настройках Telegram',
  statsTitle: '🚪 <b>Шторки перед первым 👋</b>',
  stats: (gShown: number, gDone: number, uShown: number, uDone: number, left: number) =>
    `Пол: показали ${gShown} → выбрали ${gDone} · @username: показали ${uShown} → завели ${uDone} · ушли без 👋 ${left}`
};

// «Сходки рядом» (nearbyInvite.ts): через полчаса после создания сходки бот зовёт тех, кто недалеко
const nearDistance = (m: number) => (m < 950 ? `${Math.max(100, Math.round(m / 100) * 100)} м` : `${(Math.round(m / 100) / 10).toFixed(1).replace('.', ',').replace(',0', '')} км`);
export const NEARBY_TEXTS = {
  // Первая строка приглашения. meters — от точки человека; null — точки нет (выбрал «весь Минск»)
  head: (o: { meters: number | null; sameArea: boolean; touristCenter: boolean }) =>
    '📍 Может, тебя заинтересует: ' +
    (o.meters === null
      ? 'в Минске собирают новую сходку'
      : o.touristCenter
        ? 'недалеко от центра Минска собирают сходку'
        : o.sameArea
          ? 'в твоём районе собирают сходку'
          : o.meters <= 5000
            ? `рядом с тобой собирают сходку, в ${nearDistance(o.meters)}`
            : `в Минске собирают сходку, в ${nearDistance(o.meters)} от тебя`),
  seatsLeft: (n: number) => ` · осталось ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'место' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'места' : 'мест'}`,
  // Опрос 13.11.2026: «стесняюсь идти к незнакомым» отметили 49%
  comfort: 'Приходи, даже если никого не знаешь: каждый второй у нас тоже стесняется идти к незнакомым.',
  halfHour: ' Можно зайти на полчаса.',
  openBtn: 'Открыть сходку',
  settingsBtn: '⚙️ Настроить или выключить',
  // Организатору — после рассылки
  host: (title: string, n: number, post: string) =>
    `📣 Позвал на «<b>${title}</b>» тех, кто рядом: ${people(n)}. Запишутся — бот напишет.\n\n` +
    'Хочешь, чтобы пришло больше? Расскажи о сходке в Тредсе: её увидят те, кого ещё нет в приложении. ' +
    'Стесняться нечего: ты зовёшь людей хорошо провести время, на такое откликаются охотно. Текст готов, поправь под себя:\n\n' +
    `<i>${post}</i>`,
  // Пост для Тредса — обычный текст, без разметки
  post: (title: string, when: string, where: string, link: string) =>
    `Собираю компанию: «${title}», ${when}, ${where}. Приходите, даже если никого не знаете, познакомимся на месте. Записаться: ${link}`,
  copyBtn: '📋 Скопировать текст',
  threadsBtn: 'Открыть Тредс с текстом',
  // /stats
  statsTitle: '📍 <b>Сходки рядом за 7 дней</b>',
  stats: (events: number, sent: number, opened: number, joined: number) => `Сходок с рассылкой: ${events} · позвали ${sent} · открыли ${opened} · записались ${joined}`,
  statsStopped: (after: number, invited: number, all: number) =>
    `Бот перестал доходить после приглашения: ${after} из ${invited} позванных · всего за 7 дней бота остановили ${all}`,
  statsOff: (off: number, tuned: number) => `Выключили «Сходки рядом»: ${off} · поменяли частоту или расстояние: ${tuned}`
};

// Блок «Стесняешься идти?» на карточке сходки — тем, кто ещё не был ни на одной сходке
const GOAL_LIKES: Record<string, string> = {
  walk: 'прогулки',
  cafe_bar: 'кафе и бары',
  expo_cinema: 'выставки и кино',
  trip_outdoors: 'выезды за город',
  boardgames: 'настолки',
  sport: 'спорт'
};
export const COMFORT_TEXTS = {
  // Опрос 13.11.2026: 49%
  notAlone: 'Каждый второй у нас стесняется идти к незнакомым, так что ты в хорошей компании',
  notAloneShort: 'Стесняешься? Каждый второй у нас тоже',
  firstTimers: (n: number, total: number) => `${n} из ${total} ${n === 1 ? 'идёт' : 'идут'} на сходку впервые`,
  firstTimersShort: (n: number, total: number) => `${n} из ${total} ${n === 1 ? 'идёт' : 'идут'} впервые`,
  sameArea: (n: number) => `${n} из идущих ${n === 1 ? 'живёт' : 'живут'} в твоём районе`,
  sameGoal: (n: number, goal: string) => (GOAL_LIKES[goal] ? `${n} из идущих тоже ${n === 1 ? 'любит' : 'любят'} ${GOAL_LIKES[goal]}` : ''),
  halfHour: 'Можно зайти на полчаса и уйти, если не понравится',
  halfHourShort: 'можно на полчаса',
  // /stats: первые в жизни записи на чужую сходку — две недели до блока и всё время после
  statsTitle: '🫣 <b>Новички на сходках: до и после «Стесняешься идти?»</b>',
  statsRow: (label: string, firsts: number, perDay: string, newUsers: number, viaNearby?: number) =>
    `${label}: первых записей ${firsts}${perDay ? ` (${perDay} в день)` : ''} · новых людей ${newUsers}${viaNearby !== undefined ? ` · из первых записей по приглашению «Сходки рядом» ${viaNearby}` : ''}`,
  statsEarly: 'После запуска прошло меньше суток, сравнивать рано'
};
