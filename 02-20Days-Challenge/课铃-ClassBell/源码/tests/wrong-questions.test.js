'use strict';

/**
 * 错题本解析与入库（1.10.0）。
 *
 * 结构以真机抓回来的批改详情页为准（.test-tmp/probe-out/question_214140475.html）。
 *
 * 注意：那份 HTML 里含真实作答，属于隐私数据，**不提交进仓库**。
 * 所以这里用等价的合成片段锁结构，另外留一条"本机存在真实样本就跑一遍"的用例，
 * 在开发机上验证、在别人机器上自动跳过。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { parseWrongQuestions, parseWorkSkeleton } = require('../server/chaoxing-parser.js');
const { Store } = require('../server/store.js');

const REAL_SAMPLE = path.join(repoRoot, '.test-tmp', 'probe-out', 'question_214140475.html');
const REAL_SKELETON_FULL = path.join(repoRoot, '.test-tmp', 'probe-out', '微分中值定理和洛必达法则.html');
const REAL_SKELETON_WRONG = path.join(repoRoot, '.test-tmp', 'probe-out', '无穷小与无穷大.html');

/* ------------------------------------------------------------- 合成样本 */

/**
 * 造一段结构等价于学习通批改页的 HTML：
 *  第 1 题：单选答对
 *  第 2 题：单选答错（正确答案 C、我的答案 A、得 0 分）
 *  第 3 题：判断题答错（答案"对"/"错"，选项用 p.qtDetail 写法）
 *  第 4 题：题干整道是图片、且拿不到正确答案（模拟主观题）
 * 顶部导航条里第 2、3 题带 wrongRed。
 */
function syntheticDetailPage() {
  const nav = `
    <div class="swiper-nav"><div class="swiper-wrapper navDiv">
      <div id="q1" class="swiper-slide activeGreen" data="true"><span class="allQuestion">1</span></div>
      <div id="q2" class="swiper-slide " data="false"><span class="wrongRed allQuestion">2</span></div>
      <div id="q3" class="swiper-slide " data="false"><span class="wrongRed allQuestion">3</span></div>
      <div id="q4" class="swiper-slide activeGreen" data="true"><span class="allQuestion">4</span></div>
    </div></div>`;

  const single = (no, id, right, mine, score, full) => `
    <div class="swiper-slide"><div class="slideHeight ans-cc fontLabel singleQuesId" id="questionBlock${id}" data="${id}" qType="0">
      <div class="padlr30 whiteBg">
        <div class="stemDiv">
          ${no}.<span class="stemGray">(单选题，${full}  分)</span>
          <div class="Picdiv workTextWrap qtContent"> 选出正确的一项，第${no}题</div>
        </div>
        <div class="optionDiv">
          <div class="optionCon"><span class="wrIcon"><img src="//mooc1.chaoxing.com/mooc-ans/images/work/phone/right_v1.png"/></span><div class="ptag workTextWrap qtDetail">A.甲</div></div>
          <div class="optionCon"><span class="wrIcon"></span><div class="ptag workTextWrap qtDetail">B.乙</div></div>
          <div class="optionCon"><span class="wrIcon"></span><div class="ptag workTextWrap qtDetail">C.丙</div></div>
          <div class="optionCon"><span class="wrIcon"></span><div class="ptag workTextWrap qtDetail">D.丁</div></div>
        </div>
      </div>
      <div class="grayDiv">教师批阅</div>
      <div class="answerDiv noBg"><div class="answerPtit">
        <span role="option">正确答案<span aria-label=","></span><span class="greenColor rightAnswerContent">${right}</span>，
          <span class="element-invisible-hidden">D; </span>
        </span>
        <span role="option">我的答案：<span class="${right === mine ? 'greenColor' : 'redColor'} stuAnswerContent">${mine}</span>
          <span class="element-invisible-hidden">:B; </span>
        </span>
        <span role="option">得<span class="font40"> ${score} </span>分</span>
      </div>
      <div class="Answer_analysis Color888 workTextWrap" role="option">
        <span class="analysis_tit">答案解析：</span>
        <span class="analysis_pcon qtAnalysis">第${no}题的解析</span>
      </div></div>
    </div></div>`;

  const judge = `
    <div class="swiper-slide"><div class="slideHeight ans-cc fontLabel singleQuesId" id="questionBlockq3" data="q3" qType="3">
      <div class="padlr30 whiteBg">
        <div class="stemDiv">
          3.<span class="stemGray">(判断题， 7.7  分)</span>
          <div class="Picdiv workTextWrap qtContent"> <img width="39" height="21" src="https://p.ananas.chaoxing.com/star3/origin/abc.png">这是判断题题干。</div>
        </div>
        <div class="optionDiv">
          <div class="optionCon"><span class="wrIcon"></span><p class="qtDetail">A. 对</p></div>
          <div class="optionCon"><span class="wrIcon"><img src="//mooc1.chaoxing.com/mooc-ans/images/work/phone/wrong_v1.png"/></span><p class="qtDetail">B. 错</p></div>
        </div>
      </div>
      <div class="grayDiv">教师批阅</div>
      <div class="answerDiv noBg"><div class="answerPtit">
        <span role="option">正确答案<span class="greenColor rightAnswerContent">对</span>，</span>
        <span role="option ">我的答案：<span class="stuAnswerContent">错</span></span>
        <span role="option">得<span class="font40"> 0 </span>分</span>
      </div>
      <div class="Answer_analysis Color888 workTextWrap" role="option">
        <span class="analysis_tit">答案解析：</span>
        <span class="analysis_pcon qtAnalysis">判断题的解析</span>
      </div></div>
    </div></div>`;

  // 主观题：整道题都是图片，也没有"正确答案"文字
  const subjective = `
    <div class="swiper-slide"><div class="slideHeight ans-cc fontLabel singleQuesId" id="questionBlockq4" data="q4" qType="4">
      <div class="padlr30 whiteBg">
        <div class="stemDiv">
          4.<span class="stemGray">(简答题， 10  分)</span>
          <div class="Picdiv workTextWrap qtContent"> <p><img src="http://p.ananas.chaoxing.com/star3/origin/pic.jpg" title="q.jpg"/></p></div>
        </div>
      </div>
      <div class="grayDiv">教师批阅</div>
      <div class="answerDiv noBg"><div class="answerPtit">
        <span role="option">我的答案：<span class="stuAnswerContent">我的作答文字</span></span>
        <span role="option">得<span class="font40"> 4 </span>分</span>
      </div></div>
    </div></div>`;

  return `<!doctype html><html><body>${nav}${single(1, 'q1', 'A', 'A', 7.6, 7.6)}${single(2, 'q2', 'C', 'A', 0, 7.7)}${judge}${subjective}</body></html>`;
}

/* --------------------------------------------------------------- 解析 */

test('parses every question and flags the wrong ones', () => {
  const list = parseWrongQuestions(syntheticDetailPage(), 'https://mooc1.chaoxing.com/mooc-ans/');
  assert.equal(list.length, 4, '四道题都要解析出来');

  const [q1, q2, q3, q4] = list;
  assert.equal(q1.isWrong, false);
  assert.equal(q2.isWrong, true, '第 2 题答错');
  assert.equal(q3.isWrong, true, '第 3 题答错');
  assert.equal(q4.isWrong, true, '主观题只得了部分分，也算错题');

  // 正确答案不能把读屏器的隐藏文本带进来（否则会变成 "C D"）
  assert.equal(q2.correctAnswer, 'C');
  assert.equal(q2.myAnswer, 'A');
  assert.equal(q3.correctAnswer, '对');
  assert.equal(q3.myAnswer, '错');
});

test('keeps stem images and option images with absolute urls', () => {
  const list = parseWrongQuestions(syntheticDetailPage(), 'https://mooc1.chaoxing.com/mooc-ans/');
  const q3 = list[2];

  // 协议相对的图片地址必须补成 https
  assert.ok(q3.stemImages.length >= 1);
  assert.match(q3.stemImages[0], /^https:\/\//);
  assert.ok(q3.stemHtml.includes('<img'), '题干富文本要带图片');
  assert.ok(q3.stem.includes('这是判断题题干'), '图片之外的文字要保留');
});

test('parses options from both div.ptag and p.qtDetail layouts', () => {
  const list = parseWrongQuestions(syntheticDetailPage());
  assert.equal(list[1].options.length, 4, '单选四选项');
  assert.equal(list[2].options.length, 2, '判断两个选项');
  assert.equal(list[2].options[0].key, 'A');
  assert.equal(list[2].options[0].text, 'A. 对');
});

test('keeps questions whose correct answer is missing', () => {
  // 主观题不给"正确答案"文字，不能因为缺字段就丢题
  const list = parseWrongQuestions(syntheticDetailPage());
  const sub = list[3];
  assert.equal(sub.type, '简答题');
  assert.equal(sub.correctAnswer, '');
  assert.equal(sub.isWrong, true, '拿不到正确答案也要能判成错题（靠得分）');
  assert.ok(sub.stem.includes('[图]'), '整道题是图片时题干给出 [图] 标记');
});

test('parses question type, number and score', () => {
  const list = parseWrongQuestions(syntheticDetailPage());
  assert.equal(list[0].questionNo, 1);
  assert.equal(list[0].type, '单选题');
  assert.equal(list[0].score, 7.6);
  assert.equal(list[0].fullScore, 7.6);
  assert.equal(list[1].score, 0);
  assert.equal(list[2].type, '判断题');
});

/* ------------------------------------------------------------- 骨架页 */

test('parses the skeleton page for workAnswerId, score and ids', () => {
  const html = `
    <p class="Number"> 84.6 <span>分</span> </p>
    <p>共13题，客观题13道，主观题0道</p>
    <script>var url = '/work/phone/selectWorkQuestionYiPiYue?courseId=254698270&workAnswerId=55987386&workId=57399857&knowledgeId=0&status=4&classId=155106218&oldWorkId=&mooc=1&ut=s';</script>`;
  const sk = parseWorkSkeleton(html);
  assert.equal(sk.ok, true);
  assert.equal(sk.workAnswerId, '55987386');
  assert.equal(sk.score, 84.6);
  assert.equal(sk.courseId, '254698270');
  assert.equal(sk.classId, '155106218');
  assert.equal(sk.workId, '57399857');
  assert.equal(sk.total, 13);
  assert.equal(sk.isFullScore, false);
});

test('a 100 score work is flagged so the detail request can be skipped', () => {
  const html = `
    <p class="Number"> 100 <span>分</span> </p>
    <p>共13题，客观题13道，主观题0道</p>
    <script>selectWorkQuestionYiPiYue?courseId=1&workAnswerId=2&workId=3&classId=4</script>`;
  assert.equal(parseWorkSkeleton(html).isFullScore, true);
});

test('skeleton without workAnswerId reports not ok', () => {
  const sk = parseWorkSkeleton('<html><body>登录过期</body></html>');
  assert.equal(sk.ok, false);
  assert.equal(sk.workAnswerId, '');
});

/* --------------------------------------------------------------- 入库 */

test('mistakes keep the new structured fields and dedupe by sourceKey', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-')));
  const [q2] = parseWrongQuestions(syntheticDetailPage()).slice(1, 2);

  const first = store.addMistake({
    course: '工程数学',
    title: '无穷小与无穷大',
    questionNo: q2.questionNo,
    type: q2.type,
    question: q2.stem,
    stemHtml: q2.stemHtml,
    options: q2.options,
    myAnswer: q2.myAnswer,
    correctAnswer: q2.correctAnswer,
    score: q2.score,
    fullScore: q2.fullScore,
    analysis: q2.analysis,
    source: 'chaoxing',
    sourceKey: 'cx:wrong:57399857:q2'
  });

  assert.equal(first.created, true);
  assert.equal(first.mistake.questionNo, 2);
  assert.equal(first.mistake.type, '单选题');
  assert.equal(first.mistake.correctAnswer, 'C');
  assert.equal(first.mistake.myAnswer, 'A');
  assert.equal(first.mistake.score, 0);
  assert.equal(first.mistake.fullScore, 7.7);
  assert.equal(first.mistake.options.length, 4);

  const again = store.addMistake({ question: '重复', sourceKey: 'cx:wrong:57399857:q2' });
  assert.equal(again.created, false, '同一道题不该重复入库');
  assert.equal(store.state.mistakes.length, 1);
});

/* ------------------------------------------- 真实样本（本机才有，别处跳过） */

test('real graded page yields exactly the two known wrong questions', { skip: fs.existsSync(REAL_SAMPLE) ? false : '本机没有真实样本' }, () => {
  const html = fs.readFileSync(REAL_SAMPLE, 'utf8');
  const list = parseWrongQuestions(html, 'https://mooc1.chaoxing.com/mooc-ans/work/phone/selectWorkQuestionYiPiYue');
  assert.equal(list.length, 13, '样本是 13 道题');
  const wrong = list.filter((q) => q.isWrong);
  assert.equal(wrong.length, 2, '样本里有 2 道错题');

  // 第 10 题：正确答案 C，我的答案 A
  assert.equal(wrong[0].questionNo, 10);
  assert.equal(wrong[0].correctAnswer, 'C');
  assert.equal(wrong[0].myAnswer, 'A');
  assert.equal(wrong[0].type, '单选题');

  // 第 11 题：正确答案 对，我的答案 错
  assert.equal(wrong[1].questionNo, 11);
  assert.equal(wrong[1].correctAnswer, '对');
  assert.equal(wrong[1].myAnswer, '错');
  assert.equal(wrong[1].type, '判断题');
});

test('real skeleton pages report the right score', { skip: fs.existsSync(REAL_SKELETON_WRONG) ? false : '本机没有真实样本' }, () => {
  const wrongPage = parseWorkSkeleton(fs.readFileSync(REAL_SKELETON_WRONG, 'utf8'));
  assert.equal(wrongPage.score, 84.6);
  assert.equal(wrongPage.isFullScore, false);

  const fullPage = parseWorkSkeleton(fs.readFileSync(REAL_SKELETON_FULL, 'utf8'));
  assert.equal(fullPage.score, 100);
  assert.equal(fullPage.isFullScore, true, '满分作业要能被识别出来，省掉详情请求');
});