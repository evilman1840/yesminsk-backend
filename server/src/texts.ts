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
  sourceNames: { feed: 'лента', empty: 'пустая лента', place: 'карточка места', link: 'ссылка' } as Record<string, string>,
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
  duplicate: 'Такое желание уже отмечено 🙂',
  // /stats
  statsTitle: '🙋 <b>«Хочу сходить» за 30 дней</b>',
  statsCreated: (n: number, list: string) => `Желаний: ${n}${list ? ` (${list})` : ''}`,
  statsGroups: (groups: number, built: number, rate: string) => `Совпало групп: ${groups} · из них собрали сходку: ${built} (${rate})`,
  // Где застревают открытые группы сейчас
  statsFunnel: (waitPeople: number, waitPlace: number, proposed: number, best: string, expired: number) =>
    `Сейчас в группах: ждут людей ${waitPeople} · ждут место ${waitPlace} · предложено время ${proposed}${best} · истекли без сходки (30 дн.) ${expired}`,
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
  second: 'Пока тихо? В «ГУЛЯЙ!» можно ничего не организовывать. Просто отметь, куда хочется, и бот найдёт компанию 🙂',
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
    `🙋 Вас уже ${n}, кто хочет ${what}!\n\nМесто: <b>${place}</b>.${note ? `\n${note}` : ''}\n\nКогда удобно?\n${times.map((t) => `• ${t}`).join('\n')}\n\nНажми все варианты, которые подходят. Организовывать ничего не нужно: как только на одно время наберётся ${need} «Пойду», бот соберёт встречу и напишет всем.`,
  optionBtn: (when: string) => `✅ ${when}`,
  noBtn: 'Не смогу ни в один',
  whoBtn: '👀 Кто ещё хочет',
  yesOk: (count: number, need: number, when: string) => (count >= need ? '🎉 Сходка собрана!' : `Записали на ${when}! Уже ${count} из ${need} 🙌`),
  otherTime: (when: string) => `Сходку уже собрали на ${when}. Если подходит, запишись в приложении 🙂`,
  noOk: 'Хорошо, понятно 🙂 Новое желание можно отметить в «Сходках».',
  lateJoin: '🎉 Ты в списке! Сходка уже собрана, ждём тебя.',
  gone: 'Это предложение уже неактуально 🙂',
  // Сходка собрана
  createdForYes: (title: string, when: string, where: string) =>
    `🎉 <b>Сходка собрана!</b>\n\n${title}\n🕒 ${when}\n📍 ${where}\n\nТы в списке участников. Если планы поменяются, отмени участие в приложении.`,
  openEvent: 'Открыть сходку',
  createdForHost: (title: string, when: string, where: string) =>
    `🎉 <b>Встреча собрана, и ты её хозяин!</b>\n\n${title}\n🕒 ${when}\n📍 ${where}\n\nТвоё «Пойду» было первым. Ничего особенного делать не нужно: приди чуть раньше и займи столик. В приложении можно написать участникам или поменять детали.`,
  // Напоминание тем, кто не ответил на предложение
  remind: (n: number, what: string, when: string, place: string) =>
    n > 0
      ? `🙋 Уже ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человек идёт' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'человека идут' : 'человек идут'} ${what}: <b>${when}</b>, место: ${place}.\n\nПрисоединишься? Нажми время, которое подходит 👇`
      : `🙋 Напоминаю: собираемся ${what}, место: ${place}. Нажми время, которое подходит, и как только наберётся компания, бот всё соберёт 👇`,
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
  failed: 'Не получилось отправить, попробуй ещё раз'
};

// Разрешение боту писать (открыли мини-приложение по ссылке, минуя чат с ботом)
export const BOT_ACCESS_TEXTS = {
  welcome:
    '🔔 Готово! Теперь сюда будут приходить напоминания о сходках, совпадения по «Хочу сходить» и приветы 👋. Если надоест, можно выключить подборки в анкете.',
  statsLine: (can: number, total: number, blocked: number) => `🔔 Бот может писать: ${can} из ${total}${blocked ? ` · не доходит: ${blocked}` : ''}`
};

// Нет @username в Telegram: написать не получится — просим завести
export const USERNAME_TEXTS = {
  // Тому, у кого нет username, при взаимном 👋
  noUsernameMatch: (name: string, otherHasUsername: boolean) =>
    `✍️ У тебя нет имени пользователя в Telegram, поэтому ${name} не сможет написать тебе первым.\n\n` +
    (otherHasUsername ? `Напиши первым по ссылке выше 👆 или ` : '') +
    `заведи имя пользователя, это 30 секунд: Telegram → Настройки → Изменить (или нажми на своё имя) → «Имя пользователя».`,
  statsLine: (n: number, total: number) => `✍️ Без @username: ${n} из ${total}`
};

// Шкала донатов (/fund)
export const FUND_TEXTS = {
  usage: '\n\nТак: <code>/fund 95 48,45</code>\nПервое число: всего собрано. Второе: сколько из этого в котёл для пользователей. На развитие пойдёт остальное.',
  current: (total: string, community: string, dev: string) => `💛 Сейчас: собрано <b>${total}</b>\n☕ Котёл для пользователей: ${community}\n🌱 На развитие: ${dev}`,
  saved: (total: string, community: string, dev: string) => `✅ Обновил шкалу: собрано <b>${total}</b>\n☕ Котёл для пользователей: ${community}\n🌱 На развитие: ${dev}\n\nУже видно в «Новостях» и в окне доната.`,
  bad: 'Не понял числа. Второе число не может быть больше первого.'
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
