/**
 * Тексты бота для новых функций: шаблоны сходок, «Хочу сходить», приветственный толчок.
 * Правила: на «ты», нейтрально по роду, без длинных тире
 */

export const TEMPLATE_TEXTS = {
  // /templates: подпись к таблице
  csvCaption:
    '🧩 <b>Шаблоны сходок.</b> Поправь и пришли файл обратно. Пустая ячейка ничего не меняет.\n\n' +
    'Ключ: латиницей, по нему шаблон и находится (новый ключ = новый шаблон).\n' +
    'Вкл и Платно: да / нет. Категория: Кофе/бар, Прогулка, Арт/кино, За город, Настолки, Спорт/вело, Поныть, Своя идея.\n' +
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
  funnel: (opened: number, picked: number, published: number, rate: string) =>
    `Форма: открыли ${opened} → выбрали идею ${picked} → опубликовали ${published} (${rate})`,
  quit: (atPick: number, atForm: number) => `Бросили: на выборе идеи ${atPick} · в заполненной форме ${atForm}`,
  sources: (list: string) => `Откуда открывают: ${list}`,
  sourceNames: { feed: 'лента', empty: 'пустая лента', place: 'карточка места', link: 'ссылка' } as Record<string, string>
};

// Загрузка фото сходок и анкет
export const PHOTO_TEXTS = {
  notConfigured: 'Фото пока нельзя загрузить, попробуй чуть позже',
  tooMany: 'Слишком много фото за час, попробуй позже',
  badFile: 'Это не похоже на фото: подойдут JPG, PNG или WebP',
  tooBig: 'Фото слишком большое, выбери другое',
  failed: 'Не получилось сохранить фото, попробуй ещё раз'
};

// Цена сходки: бесплатно или платно (по умолчанию бесплатно)
export const PRICE_TEXTS = {
  free: '💚 Бесплатно',
  paid: '💸 Платно',
  paidAmount: (amount: number) => `💸 Платно, примерно ${String(amount).replace('.', ',')} BYN`,
  freeShort: 'бесплатно',
  paidShort: 'платно',
  paidAmountShort: (amount: number) => `~${String(amount).replace('.', ',')} BYN`
};

export const priceLabel = (ev: { isPaid?: boolean; price?: number }) =>
  !ev.isPaid ? PRICE_TEXTS.free : ev.price ? PRICE_TEXTS.paidAmount(ev.price) : PRICE_TEXTS.paid;
export const priceShort = (ev: { isPaid?: boolean; price?: number }) =>
  !ev.isPaid ? PRICE_TEXTS.freeShort : ev.price ? PRICE_TEXTS.paidAmountShort(ev.price) : PRICE_TEXTS.paidShort;

// «Хочу сходить»
const people = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человек' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'человека' : 'человек'}`;

export const WISH_TEXTS = {
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
  openApp: 'Открыть ДА! МИНСК',
  // Ошибки
  tooMany: (max: number) => `Можно держать не больше ${max} желаний сразу. Убери одно из старых.`,
  badKind: 'Такого варианта нет',
  duplicate: 'Такое желание уже отмечено 🙂',
  // /stats
  statsTitle: '🙋 <b>«Хочу сходить» за 30 дней</b>',
  statsCreated: (n: number, list: string) => `Желаний: ${n}${list ? ` (${list})` : ''}`,
  statsGroups: (groups: number, built: number, rate: string) => `Совпало групп: ${groups} · из них собрали сходку: ${built} (${rate})`,
  statsLinks: (n: number, withProfile: number) => `По ссылкам wish_: ${people(n)}, из них заполнили анкету ${withProfile}`,
  statsActive: (n: number) => `Активных желаний сейчас: ${n}`
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
  second: 'Пока тихо? В ДА! МИНСК можно ничего не организовывать. Просто отметь, куда хочется, и бот найдёт компанию 🙂',
  wishBtn: 'Хочу сходить',
  offBtn: 'Не сейчас',
  offOk: 'Хорошо, больше не будем напоминать 🙂',
  // /nudge — превью для автора
  previewNote: '<i>Так люди увидят сообщения бота: два приветственных и напоминание про анкету (оно подстроится под то, что не заполнено):</i>',
  // /stats
  statsTitle: '👋 <b>Приветственный толчок за 30 дней</b>',
  statsSent: (first: number, second: number) => `Отправлено: первых ${first}, вторых ${second}`,
  statsVariant: (v: string, sent: number, acted: number, rate: string) => `${v}: ${sent} → за 48 ч что-то сделали ${acted} (${rate})`,
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
  button: '✏️ Заполнить анкету',
  // /stats
  statsTitle: '✏️ <b>Напоминание про анкету</b>',
  statsLine: (sent: number, filled: number, rate: string) => `Отправлено ${sent} · из них дополнили анкету ${filled} (${rate})`
};
