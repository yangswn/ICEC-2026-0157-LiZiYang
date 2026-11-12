'use strict';

/** Development-only fixture used by the UI smoke test. Never shipped in the installer. */
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.test-data'));
fs.mkdirSync(dir, { recursive: true });
const now = new Date();
const at = (dayOffset, hour, minute = 0) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
  return d.toISOString();
};

const tasks = [
  {
    id: 't_demo_1', title: '第七章 · 多元函数微分学习题', course: '高等数学（下）',
    category: 'homework', priority: 'urgent', dueAt: at(0, 22, 0),
    notes: '习题 7.3 第 1—12 题，写清步骤。', status: 'pending',
    reminderOffsets: [60, 10], recurrence: 'none', source: 'manual'
  },
  {
    id: 't_demo_2', title: '课程设计报告：校园任务提醒工具', course: '软件工程',
    category: 'homework', priority: 'important', dueAt: at(1, 23, 59),
    notes: '按实验指导书模板提交 PDF，附运行截图。', status: 'pending',
    reminderOffsets: [1440, 60, 10], recurrence: 'none', source: 'chaoxing',
    sourceKey: 'cx:work:demo-2', sourceUrl: 'https://mooc1.chaoxing.com/'
  },
  {
    id: 't_demo_3', title: 'Unit 5 在线单元测验', course: '大学英语（三）',
    category: 'exam', priority: 'important', dueAt: at(3, 20, 0),
    notes: '', status: 'pending', reminderOffsets: [1440, 60], recurrence: 'none', source: 'chaoxing',
    sourceKey: 'cx:exam:demo-3', sourceUrl: 'https://mooc1.chaoxing.com/'
  },
  {
    id: 't_demo_4', title: '课程论文：中国式现代化的实践逻辑', course: '马克思主义基本原理',
    category: 'homework', priority: 'normal', dueAt: at(5, 18, 0),
    notes: '不少于 2000 字，参考文献 5 篇以上。', status: 'pending',
    reminderOffsets: [1440, 60], recurrence: 'none', source: 'manual'
  },
  {
    id: 't_demo_5', title: '实验三：二叉搜索树的实现', course: '数据结构',
    category: 'homework', priority: 'urgent', dueAt: at(-1, 23, 59),
    notes: '已过期，用于检查逾期样式。', status: 'pending',
    reminderOffsets: [60, 10], recurrence: 'none', source: 'chaoxing',
    sourceKey: 'cx:work:demo-5', sourceUrl: 'https://mooc1.chaoxing.com/'
  },
  {
    id: 't_demo_6', title: '每周复盘与下周计划', course: '',
    category: 'schedule', priority: 'normal', dueAt: at(2, 21, 0),
    notes: '', status: 'pending', reminderOffsets: [10], recurrence: 'weekly', source: 'manual'
  },
  {
    id: 't_demo_7', title: '提交形势与政策心得体会', course: '形势与政策',
    category: 'homework', priority: 'normal', dueAt: at(-2, 18, 0),
    notes: '', status: 'done', completedAt: at(-2, 17, 20), completedBy: 'user',
    reminderOffsets: [60], recurrence: 'none', source: 'manual'
  }
].map((task) => ({
  ...task,
  createdAt: at(-7, 9),
  updatedAt: at(-1, 20),
  completedAt: task.completedAt || null,
  completedBy: task.completedBy || '',
  seriesId: '',
  remindersSent: [],
  remoteStatus: 0,
  lastSeenAt: ''
}));

const state = {
  schema: 1,
  createdAt: at(-7, 9),
  updatedAt: now.toISOString(),
  tasks,
  candidates: [
    {
      id: 'c_demo_1', title: '第 8 章 章节测验', course: '线性代数',
      dueAt: null, sourceKey: 'cx:work:c8', sourceUrl: 'https://mooc1.chaoxing.com/',
      type: 'work', reason: 'no_deadline', discoveredAt: now.toISOString()
    },
    {
      id: 'c_demo_2', title: '小组讨论：项目风险管理', course: '软件工程',
      dueAt: null, sourceKey: 'cx:work:risk', sourceUrl: 'https://mooc1.chaoxing.com/',
      type: 'work', reason: 'no_deadline', discoveredAt: now.toISOString()
    }
  ],
  settings: {
    autoLaunch: true, closeToTray: true, autoSync: true, autoSyncIntervalMin: 30,
    autoAddFromChaoxing: true, reminderOffsets: [60, 10], sound: true,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    logMirrorDir: '', displayName: '', firstRun: false
  },
  sync: {
    lastSyncAt: at(0, 9, 12), lastAttemptAt: at(0, 9, 12), lastResult: 'ok',
    courses: 7, recognized: 6, added: 4, updated: 2, error: '', accountLabel: '林同学'
  },
  metrics: { totalAdded: 18, totalCompleted: 11, totalSynced: 26, totalReminders: 9 }
};

fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(state, null, 2), 'utf8');
fs.mkdirSync(path.join(dir, 'process_logs'), { recursive: true });
console.log('seeded', path.join(dir, 'data.json'));
