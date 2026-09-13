// ==================== 共享状态(全站唯一可变数据容器) ====================
// 职责:集中存放跨模块数据。允许依赖:无。禁止:任何逻辑与 DOM。
// 注意:ESM 导出为只读绑定,因此暴露 const 对象、只改属性不改绑定。

export const state = {
    // 题库
    questionBanks: {},
    // 题库卡配色(👤 定稿):库名 → 'blue'|'green'|'red'|'amber'|'teal';缺省即灰,不存在此表里
    bankColors: {},
    questionBank: [],
    currentBankName: '默认题库',
    isAllBanksView: false,
    // 错题本
    errorQuestions: [],
    expandedBanks: {},
    masteryThreshold: 2,
    // 收藏夹
    favoriteQuestions: [],
    // 刷题会话
    currentQuiz: [],
    currentQuestionIndex: 0,
    correctCount: 0,
    wrongCount: 0,
    isAnswered: false,
    quizMode: 'immediate',
    userAnswers: [],
    masteryRemovedInSession: 0,
    autoNext: false,          // 自动下一题(默认关闭,存本机)
    // 导入预览
    previewData: [],
    previewFilterWarned: false,
    // 多题库导入(带分节标记的文件):[{name,count}];mode = 'separate'(按库分开) | 'merge'(全部并一库)
    previewBanks: [],
    previewBankMode: 'merge',
    // 题库编辑器
    editBankName: null,
    editIndex: 0,
    editorDirty: false,
    // 「只看待补答案」= editorFilter.status 里有 'pending' 的**派生值**(老代码/老测试仍读它)
    editorPendingOnly: false,
    // 多选:存的是**题目对象本身**,不是下标 —— 删/筛/去重都会让下标移位,
    // 存下标就会出现"删了第 2 题,第 3 题莫名被选中/删掉"(踩过同类坑)
    editorSelected: [],
    // 编辑级撤销栈(👤 2026-09-13 定:只放内存、会话内)。
    // 存的是**闭包**(每条自带 undo/redo + 一句人话标签);因为不落盘、不序列化,闭包是最省事也最稳的表示。
    // 深度上限 50,超了丢最旧;任何新动作都会清空 redoStack。
    undoStack: [],
    redoStack: [],
    // 题目列表筛选(👤 2026-09-12):组内**任一**、组间**同时**。
    //   status: pending(待补答案) / noAnalysis(缺解析) / noExplanation(缺解释) / fewOptions(选项不足)
    //   ai    : touched(AI 整理过) / answer(答案来自 AI) / analysis(解析来自 AI)
    //   marks : hist(有历史标记)
    //   type  : '单选' | '多选' | '判断'
    editorFilter: { type: [], status: [], ai: [], marks: [] },
    currentRenameBank: null,
};
