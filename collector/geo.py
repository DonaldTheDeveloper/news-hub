"""Country data + finding which countries a headline is about.

Countries come from the Natural Earth 110m map (public domain). A few small places that the
low-resolution map leaves out (Singapore, Hong Kong, Malta ...) are added as point-only
"countries" so their news still gets a pin on the globe.
"""
import os
import re
import json

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD = os.path.join(HERE, "vendor", "world.geojson")

# points without a polygon on the 110m map: iso2 -> (name, lat, lon, continent)
EXTRA = {
    "SG": ("Singapore", 1.35, 103.82, "Asia"), "HK": ("Hong Kong", 22.32, 114.17, "Asia"),
    "MT": ("Malta", 35.9, 14.45, "Europe"), "BH": ("Bahrain", 26.07, 50.55, "Asia"),
    "MU": ("Mauritius", -20.3, 57.55, "Africa"), "MV": ("Maldives", 3.2, 73.2, "Asia"),
    "LI": ("Liechtenstein", 47.16, 9.55, "Europe"), "MC": ("Monaco", 43.74, 7.42, "Europe"),
    "AD": ("Andorra", 42.55, 1.6, "Europe"), "VA": ("Vatican City", 41.9, 12.45, "Europe"),
    "BB": ("Barbados", 13.19, -59.54, "North America"), "MO": ("Macau", 22.2, 113.55, "Asia"),
    "BM": ("Bermuda", 32.3, -64.75, "North America"), "SC": ("Seychelles", -4.68, 55.49, "Africa"),
    "CV": ("Cape Verde", 16.0, -24.0, "Africa"), "KM": ("Comoros", -11.65, 43.33, "Africa"),
    "WS": ("Samoa", -13.76, -172.1, "Oceania"), "TO": ("Tonga", -21.18, -175.2, "Oceania"),
    "SM": ("San Marino", 43.94, 12.46, "Europe"), "GI": ("Gibraltar", 36.14, -5.35, "Europe"),
}

# names a headline might use. Latin-script aliases are matched as whole words (case sensitive);
# other scripts as substrings. Separators: ';'
ALIASES = """
US|United States;U.S.;USA;US;America;American;Americans;Washington;White House;Pentagon;Capitol Hill;Wall Street;Estados Unidos;États-Unis;Stati Uniti;Vereinigte Staaten;США;الولايات المتحدة;美国;美國;アメリカ;米国;미국;अमेरिका;Amerika
GB|United Kingdom;UK;U.K.;Britain;British;Brits;England;English;Scotland;Scottish;Wales;Welsh;London;Downing Street;Westminster;Reino Unido;Royaume-Uni;Regno Unito;Großbritannien;Grã-Bretanha;Британия;Великобритания;بريطانيا;英国;英國;イギリス;영국;ब्रिटेन;Birleşik Krallık
RU|Russia;Russian;Russians;Moscow;Kremlin;Putin;Rusia;Russie;Russland;Rússia;Россия;России;Москва;روسيا;俄罗斯;俄羅斯;ロシア;러시아;रूस;Rusya
UA|Ukraine;Ukrainian;Ukrainians;Kyiv;Kiev;Kharkiv;Odesa;Zelensky;Ucrania;Ucrânia;Ukraina;Україна;України;Украина;Украины;أوكرانيا;乌克兰;烏克蘭;ウクライナ;우크라이나;यूक्रेन;Київ
CN|China;Chinese;Beijing;Shanghai;Chine;Cina;Китай;Китая;الصين;中国;中國;北京;中国人;中国政府;चीन;Çin;Çin'in
IL|Israel;Israeli;Israelis;Jerusalem;Tel Aviv;Israël;Israele;Израиль;Израиля;إسرائيل;以色列;イスラエル;이스라엘;इज़रायल;इसराइल;İsrail
PS|Palestine;Palestinian;Palestinians;Gaza;West Bank;Hamas;Ramallah;Palestina;Palestine;Палестина;فلسطين;غزة;غزّة;巴勒斯坦;加沙;パレスチナ;ガザ;가자;गाज़ा;Filistin
IR|Iran;Iranian;Iranians;Tehran;Irán;Iran;Иран;إيران;伊朗;イラン;이란;ईरान;İran
IN|India;Indian;Indians;New Delhi;Delhi;Mumbai;Modi;Inde;Indien;Índia;Индия;الهند;印度;インド;인도;भारत;हिंदुस्तान;ভারত;இந்தியா
PK|Pakistan;Pakistani;Islamabad;Karachi;Lahore;Paquistão;Пакистан;باكستان;巴基斯坦;パキスタン;पाकिस्तान;پاکستان
DE|Germany;German;Germans;Berlin;Bundestag;Alemania;Allemagne;Deutschland;Alemanha;Germania;Германия;Германии;ألمانيا;德国;德國;ドイツ;독일;जर्मनी;Almanya
FR|France;French;Paris;Élysée;Francia;Frankreich;França;Франция;فرنسا;法国;法國;フランス;프랑스;फ्रांस;Fransa
IT|Italy;Italian;Italians;Rome;Italia;Italie;Italien;Itália;Италия;إيطاليا;意大利;イタリア;이탈리아;इटली;İtalya
ES|Spain;Spanish;Madrid;Barcelona;España;Espagne;Spanien;Espanha;Spagna;Испания;إسبانيا;西班牙;スペイン;스페인;स्पेन;İspanya
PT|Portugal;Portuguese;Lisbon;Lisboa;Portugal;Португалия;البرتغال;葡萄牙;ポルトガル
JP|Japan;Japanese;Tokyo;Japón;Japon;Japão;Giappone;Япония;اليابان;日本;東京;东京;일본;जापान;Japonya
KR|South Korea;South Korean;Seoul;Corea del Sur;Corée du Sud;Südkorea;Coreia do Sul;Южная Корея;كوريا الجنوبية;韩国;韓國;韓国;대한민국;한국;서울;दक्षिण कोरिया;Güney Kore
KP|North Korea;North Korean;Pyongyang;Corea del Norte;Corée du Nord;Nordkorea;Coreia do Norte;Северная Корея;كوريا الشمالية;朝鲜;北朝鮮;북한;उत्तर कोरिया;Kuzey Kore
TW|Taiwan;Taiwanese;Taipei;Taiwán;Тайвань;تايوان;台湾;台灣;대만;ताइवान
TR|Turkey;Turkish;Ankara;Istanbul;Türkiye;Turquía;Turquie;Türkei;Turquia;Турция;تركيا;土耳其;トルコ;튀르키예;तुर्की;Türk
SA|Saudi Arabia;Saudi;Riyadh;Arabia Saudita;Arabia Saudí;Arabie saoudite;Saudi-Arabien;Arábia Saudita;Саудовская Аравия;السعودية;沙特;サウジアラビア;사우디;सऊदी अरब;Suudi Arabistan
AE|United Arab Emirates;UAE;Emirati;Dubai;Abu Dhabi;Emiratos Árabes;Émirats arabes;Vereinigte Arabische Emirate;ОАЭ;الإمارات;阿联酋;アラブ首長国連邦;संयुक्त अरब अमीरात
QA|Qatar;Qatari;Doha;Катар;قطر;卡塔尔
EG|Egypt;Egyptian;Cairo;Egipto;Égypte;Ägypten;Egito;Египет;مصر;埃及;エジプト;이집트;मिस्र;Mısır
SY|Syria;Syrian;Damascus;Siria;Syrie;Syrien;Síria;Сирия;سوريا;叙利亚;シリア;시리아;सीरिया;Suriye
IQ|Iraq;Iraqi;Baghdad;Irak;Iraque;Ирак;العراق;伊拉克;イラク;इराक
LB|Lebanon;Lebanese;Beirut;Líbano;Liban;Libanon;Ливан;لبنان;黎巴嫩;レバノン;लेबनान;Lübnan
JO|Jordan;Jordanian;Amman;Jordania;Jordanie;Jordanien;Jordânia;Иордания;الأردن;约旦;ヨルダン
YE|Yemen;Yemeni;Houthi;Houthis;Sanaa;Yemen;Йемен;اليمن;也门;イエメン;यमन
AF|Afghanistan;Afghan;Kabul;Taliban;Afganistán;Afghanistan;Афганистан;أفغانستان;阿富汗;アフガニスタン;अफ़ग़ानिस्तान;افغانستان
BD|Bangladesh;Bangladeshi;Dhaka;Бангладеш;بنغلاديش;孟加拉国;バングラデシュ;बांग्लादेश;বাংলাদেশ
LK|Sri Lanka;Sri Lankan;Colombo;Шри-Ланка;سريلانكا;斯里兰卡;スリランカ;श्रीलंका
NP|Nepal;Nepali;Kathmandu;Непал;نيبال;尼泊尔;ネパール;नेपाल
MM|Myanmar;Burma;Burmese;Naypyidaw;Yangon;Мьянма;ميانمار;缅甸;ミャンマー;म्यांमार
TH|Thailand;Thai;Bangkok;Tailandia;Thaïlande;Tailândia;Таиланд;تايلاند;泰国;タイ;태국;थाईलैंड
VN|Vietnam;Vietnamese;Hanoi;Ho Chi Minh City;Vietnam;Вьетнам;فيتنام;越南;ベトナム;베트남;वियतनाम;Việt Nam
ID|Indonesia;Indonesian;Jakarta;Indonesia;Индонезия;إندونيسيا;印度尼西亚;インドネシア;인도네시아;इंडोनेशिया;Endonezya
MY|Malaysia;Malaysian;Kuala Lumpur;Malasia;Malaisie;Malásia;Малайзия;ماليزيا;马来西亚;マレーシア
PH|Philippines;Filipino;Manila;Filipinas;Philippinen;Филиппины;الفلبين;菲律宾;フィリピン;필리핀
AU|Australia;Australian;Australians;Sydney;Melbourne;Canberra;Australien;Австралия;أستراليا;澳大利亚;オーストラリア;호주;ऑस्ट्रेलिया;Avustralya
NZ|New Zealand;Kiwi;Auckland;Wellington;Nueva Zelanda;Nouvelle-Zélande;Neuseeland;Nova Zelândia;Новая Зеландия;新西兰;ニュージーランド
CA|Canada;Canadian;Canadians;Ottawa;Toronto;Ontario;Quebec;Canadá;Kanada;Канада;كندا;加拿大;カナダ;कनाडा
MX|Mexico;Mexican;Mexicans;Mexico City;México;Mexique;Mexiko;Мексика;المكسيك;墨西哥;メキシコ;멕시코;मेक्सिको;Meksika
BR|Brazil;Brazilian;Brazilians;Brasília;Rio de Janeiro;São Paulo;Brasil;Brésil;Brasilien;Бразилия;البرازيل;巴西;ブラジル;브라질;ब्राज़ील;Brezilya
AR|Argentina;Argentine;Argentinian;Buenos Aires;Milei;Argentine;Argentinien;Аргентина;الأرجنتين;阿根廷;アルゼンチン
CL|Chile;Chilean;Santiago;Чили;تشيلي;智利;チリ
CO|Colombia;Colombian;Bogotá;Bogota;Kolumbien;Колумбия;كولومبيا;哥伦比亚;コロンビア
PE|Peru;Peruvian;Lima;Perú;Pérou;Перу;بيرو;秘鲁;ペルー
VE|Venezuela;Venezuelan;Caracas;Maduro;Венесуэла;فنزويلا;委内瑞拉;ベネズエラ
CU|Cuba;Cuban;Havana;La Habana;Куба;كوبا;古巴;キューバ
EC|Ecuador;Ecuadorian;Quito;Ecuador;Эквадор;الإكوادور;厄瓜多尔
BO|Bolivia;Bolivian;La Paz;Bolivie;Боливия;بوليفيا;玻利维亚
UY|Uruguay;Uruguayan;Montevideo
PY|Paraguay;Paraguayan;Asunción
HT|Haiti;Haitian;Port-au-Prince;Haití;Haïti;Гаити;هايتي;海地
ZA|South Africa;South African;Pretoria;Johannesburg;Cape Town;Sudáfrica;Afrique du Sud;Südafrika;África do Sul;ЮАР;جنوب أفريقيا;南非;南アフリカ
NG|Nigeria;Nigerian;Lagos;Abuja;Nigéria;Нигерия;نيجيريا;尼日利亚
KE|Kenya;Kenyan;Nairobi;Kenia;Кения;كينيا;肯尼亚
ET|Ethiopia;Ethiopian;Addis Ababa;Etiopía;Éthiopie;Äthiopien;Etiópia;Эфиопия;إثيوبيا;埃塞俄比亚
SD|Sudan;Sudanese;Khartoum;Sudán;Soudan;Судан;السودان;苏丹
SS|South Sudan;Juba;Sudán del Sur;Soudan du Sud;Южный Судан;جنوب السودان
SO|Somalia;Somali;Mogadishu;Somalie;Сомали;الصومال;索马里
LY|Libya;Libyan;Tripoli;Libia;Libye;Libyen;Ливия;ليبيا;利比亚
DZ|Algeria;Algerian;Algiers;Argelia;Algérie;Algerien;Argélia;Алжир;الجزائر;阿尔及利亚
MA|Morocco;Moroccan;Rabat;Marruecos;Maroc;Marokko;Marrocos;Марокко;المغرب;摩洛哥
TN|Tunisia;Tunisian;Tunis;Túnez;Tunisie;Tunesien;Tunísia;Тунис;تونس;突尼斯
GH|Ghana;Ghanaian;Accra;Гана;غانا;加纳
CD|Congo;Congolese;Kinshasa;RDC;DR Congo;DRC;RD Congo;Конго;الكونغو;刚果
UG|Uganda;Ugandan;Kampala;Уганда;أوغندا;乌干达
TZ|Tanzania;Tanzanian;Dodoma;Dar es Salaam;Tanzanie;Танзания;تنزانيا
ZW|Zimbabwe;Zimbabwean;Harare;Зимбабве;زيمبابوي
SN|Senegal;Senegalese;Dakar;Sénégal;Сенегал;السنغال
CI|Ivory Coast;Côte d'Ivoire;Abidjan;Costa de Marfil;Elfenbeinküste;Кот-д'Ивуар
CM|Cameroon;Cameroonian;Yaoundé;Camerún;Cameroun;Kamerun;Камерун;الكاميرون
ML|Mali;Malian;Bamako;Malí;Мали;مالي
NE|Niger;Nigerien;Niamey;Нигер;النيجر
BF|Burkina Faso;Ouagadougou;Буркина-Фасо;بوركينا فاسو
AO|Angola;Angolan;Luanda;Ангола;أنغولا
MZ|Mozambique;Maputo;Moçambique;Mozambique;Мозамбик
RW|Rwanda;Rwandan;Kigali;Руанда
ZM|Zambia;Zambian;Lusaka;Замбия
MG|Madagascar;Antananarivo;Мадагаскар
PL|Poland;Polish;Warsaw;Polonia;Pologne;Polen;Polónia;Польша;بولندا;波兰;ポーランド;폴란드
NL|Netherlands;Dutch;Amsterdam;The Hague;Países Bajos;Pays-Bas;Niederlande;Países Baixos;Нидерланды;هولندا;荷兰;オランダ
BE|Belgium;Belgian;Brussels;Bélgica;Belgique;Belgien;Бельгия;بلجيكا;比利时;ベルギー
CH|Switzerland;Swiss;Bern;Zurich;Geneva;Suiza;Suisse;Schweiz;Suíça;Швейцария;سويسرا;瑞士;スイス
AT|Austria;Austrian;Vienna;Österreich;Autriche;Áustria;Австрия;النمسا;奥地利;オーストリア
SE|Sweden;Swedish;Stockholm;Suecia;Suède;Schweden;Suécia;Швеция;السويد;瑞典;スウェーデン
NO|Norway;Norwegian;Oslo;Noruega;Norvège;Norwegen;Норвегия;النرويج;挪威;ノルウェー
DK|Denmark;Danish;Copenhagen;Dinamarca;Danemark;Dänemark;Dania;Дания;الدنمارك;丹麦;デンマーク
FI|Finland;Finnish;Helsinki;Finlandia;Finlande;Finnland;Finlândia;Финляндия;فنلندا;芬兰;フィンランド
IE|Ireland;Irish;Dublin;Irlanda;Irlande;Irland;Ирландия;أيرلندا;爱尔兰;アイルランド
IS|Iceland;Icelandic;Reykjavik;Islandia;Islande;Island;Исландия
GR|Greece;Greek;Athens;Grecia;Grèce;Griechenland;Grécia;Греция;اليونان;希腊;ギリシャ;그리스
CZ|Czech Republic;Czechia;Czech;Prague;República Checa;Tchéquie;Tschechien;Чехия;التشيك;捷克
HU|Hungary;Hungarian;Budapest;Hungría;Hongrie;Ungarn;Hungria;Венгрия;المجر;匈牙利
RO|Romania;Romanian;Bucharest;Rumania;Roumanie;Rumänien;Romênia;Румыния;رومانيا;罗马尼亚
BG|Bulgaria;Bulgarian;Sofia;Bulgarie;Bulgarien;Болгария;بلغاريا;保加利亚
RS|Serbia;Serbian;Belgrade;Serbie;Serbien;Sérvia;Сербия;صربيا;塞尔维亚
HR|Croatia;Croatian;Zagreb;Croacia;Croatie;Kroatien;Croácia;Хорватия;克罗地亚
BA|Bosnia;Bosnian;Sarajevo;Bosnia and Herzegovina;Bosnie;Босния
SK|Slovakia;Slovak;Bratislava;Eslovaquia;Slovaquie;Slowakei;Словакия
SI|Slovenia;Slovenian;Ljubljana;Eslovenia;Slovénie;Slowenien;Словения
LT|Lithuania;Lithuanian;Vilnius;Lituania;Lituanie;Litauen;Литва
LV|Latvia;Latvian;Riga;Letonia;Lettonie;Lettland;Латвия
EE|Estonia;Estonian;Tallinn;Estonie;Estland;Эстония
BY|Belarus;Belarusian;Minsk;Bielorrusia;Biélorussie;Weißrussland;Belarus;Белоруссия;Беларусь;白俄罗斯
MD|Moldova;Moldovan;Chisinau;Moldavia;Moldavie;Moldau;Молдова
GE|Tbilisi;Georgian government;Georgia's;Грузия;جورجيا;格鲁吉亚
AM|Armenia;Armenian;Yerevan;Armenia;Arménie;Armenien;Армения;أرمينيا
AZ|Azerbaijan;Azerbaijani;Baku;Azerbaiyán;Azerbaïdjan;Aserbaidschan;Азербайджан;أذربيجان
KZ|Kazakhstan;Kazakh;Astana;Almaty;Kazajistán;Kazakhstan;Kasachstan;Казахстан;كازاخستان;哈萨克斯坦
UZ|Uzbekistan;Uzbek;Tashkent;Uzbekistán;Ouzbékistan;Usbekistan;Узбекистан;أوزبكستان
KG|Kyrgyzstan;Kyrgyz;Bishkek;Kirguistán;Kirghizistan;Kirgisistan;Кыргызстан
CY|Cyprus;Cypriot;Nicosia;Chipre;Chypre;Zypern;Кипр
LU|Luxembourg;Luxembourgish
MN|Mongolia;Mongolian;Ulaanbaatar;Mongolie;Монголия;蒙古
KH|Cambodia;Cambodian;Phnom Penh;Camboya;Cambodge;Kambodscha;Камбоджа;柬埔寨
LA|Laos;Laotian;Vientiane;Лаос;老挝
PG|Papua New Guinea;Port Moresby;Papúa Nueva Guinea
FJ|Fiji;Fijian;Suva
GL|Greenland;Nuuk;Groenlandia;Groenland;Grönland;Гренландия;格陵兰
GT|Guatemala;Guatemalan;Guatemala City;Гватемала
HN|Honduras;Honduran;Tegucigalpa;Гондурас
SV|El Salvador;Salvadoran;San Salvador;Bukele;Сальвадор
NI|Nicaragua;Nicaraguan;Managua;Никарагуа
CR|Costa Rica;Costa Rican;San José;Коста-Рика
PA|Panama;Panamanian;Panamá;Панама;巴拿马
DO|Dominican Republic;Santo Domingo;República Dominicana;Доминикана
JM|Jamaica;Jamaican;Kingston;Ямайка
PR|Puerto Rico;Puerto Rican;San Juan
GY|Guyana;Guyanese;Georgetown
SR|Suriname;Paramaribo
SG|Singapore;Singaporean;Singapur;Singapour;Сингапур;新加坡;シンガポール
HK|Hong Kong;Hongkong;Hong-Kong;香港;홍콩;هونغ كونغ
MT|Malta;Maltese;Valletta
BH|Bahrain;Bahraini;Manama;البحرين
KW|Kuwait;Kuwaiti;Kuwait City;Kuwait;Кувейт;الكويت;科威特
OM|Oman;Omani;Muscat;Omán;Оман;عمان
LR|Liberia;Liberian;Monrovia
SL|Sierra Leone;Freetown
GN|Guinea;Guinean;Conakry
TG|Togo;Togolese;Lomé
BJ|Benin;Beninese;Cotonou
ER|Eritrea;Eritrean;Asmara
DJ|Djibouti
MR|Mauritania;Mauritanian;Nouakchott;Mauritanie
NA|Namibia;Namibian;Windhoek
BW|Botswana;Gaborone
MW|Malawi;Malawian;Lilongwe
TD|Chad;N'Djamena;Tchad;Чад
CF|Central African Republic;Bangui
GA|Gabon;Libreville
CG|Brazzaville;Republic of the Congo;Congo-Brazzaville
KE|Kenya;Nairobi
"""

_countries = None
_matcher = None


def _valid_iso(props):
    code = props.get("ISO_A2_EH") or props.get("ISO_A2")
    if code and code not in ("-99", "-1"):
        return code
    return {"N. Cyprus": "XC", "Somaliland": "XS", "Kosovo": "XK", "France": "FR", "Norway": "NO"}.get(props.get("NAME"))


def load_countries():
    """{iso2: {name, lat, lon, continent, polygon: bool}}"""
    global _countries
    if _countries is not None:
        return _countries
    out = {}
    with open(WORLD, "r", encoding="utf-8") as f:
        world = json.load(f)
    for feat in world["features"]:
        p = feat["properties"]
        iso = _valid_iso(p)
        if not iso:
            continue
        name = p["NAME"]
        if "." in name:                                  # abbreviations like 'Dem. Rep. Congo' -> full name
            name = p.get("NAME_LONG") or name
        name = {"United States of America": "United States", "Czechia": "Czechia", "eSwatini": "Eswatini",
                "Dem. Rep. Congo": "DR Congo", "Congo": "Congo (Republic)"}.get(name, name)
        if name in ("Democratic Republic of the Congo",):
            name = "DR Congo"
        out[iso] = dict(name=name, lat=round(p.get("LABEL_Y", 0), 2), lon=round(p.get("LABEL_X", 0), 2),
                        continent=p.get("CONTINENT", ""), polygon=True)
    for iso, (name, lat, lon, cont) in EXTRA.items():
        out.setdefault(iso, dict(name=name, lat=lat, lon=lon, continent=cont, polygon=False))
    # a couple of label positions that look better nudged
    out.get("US", {}).update(lat=39.0, lon=-98.0)
    out.get("FR", {}).update(lat=46.6, lon=2.4)
    out.get("NO", {}).update(lat=61.0, lon=9.0)
    out.get("RU", {}).update(lat=58.0, lon=60.0)
    _countries = out
    return out


def _latin(alias):
    return all(ord(c) < 0x250 or c in "’'" for c in alias)      # Latin (incl. accents) script


def _build():
    global _matcher
    countries = load_countries()
    latin, other, owner = [], [], {}
    for line in ALIASES.strip().splitlines():
        iso, names = line.split("|", 1)
        if iso not in countries:
            continue
        for a in names.split(";"):
            a = a.strip()
            if len(a) < 2:
                continue
            owner.setdefault(a, iso)
            (latin if _latin(a) else other).append(a)
    latin = sorted(set(latin), key=len, reverse=True)
    other = sorted(set(other), key=len, reverse=True)
    parts = []
    if latin:
        parts.append(r"(?<![\w-])(?:" + "|".join(re.escape(a) for a in latin) + r")(?![\w])")
    if other:
        parts.append("(?:" + "|".join(re.escape(a) for a in other) + ")")
    _matcher = (re.compile("|".join(parts)), owner)


def tag_countries(text, limit=3):
    """ISO codes of the countries a piece of text mentions (in order of first appearance)."""
    if _matcher is None:
        _build()
    rx, owner = _matcher
    found = []
    for m in rx.finditer(text or ""):
        iso = owner.get(m.group(0))
        if iso and iso not in found:
            found.append(iso)
            if len(found) >= limit:
                break
    return found
