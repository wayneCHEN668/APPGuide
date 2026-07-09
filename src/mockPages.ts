/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MockPage } from "./types";

export const MOCK_PAGES: MockPage[] = [
  {
    url: "/erp/loans/apply",
    title: "个人信用贷款申请",
    description: "信贷专员客户进件录入系统 - 严格遵守 KYC 要求及最高 50 万限额标准",
    fields: [
      {
        id: "customer-name",
        label: "客户法定姓名",
        selector: "#customer-name",
        type: "text",
        placeholder: "例：张伟 (须与身份证严格一致)",
        defaultValue: ""
      },
      {
        id: "id-card",
        label: "身份证号码 (18位)",
        selector: "#id-card",
        type: "text",
        placeholder: "例：110101199003072345",
        defaultValue: ""
      },
      {
        id: "monthly-income",
        label: "月核定净收入 (RMB)",
        selector: "#monthly-income",
        type: "number",
        placeholder: "请输入经银行流水核对后的月度税后收入",
        defaultValue: ""
      },
      {
        id: "loan-amount",
        label: "申请借款金额 (RMB)",
        selector: "#loan-amount",
        type: "number",
        placeholder: "最高额度 500,000 元",
        defaultValue: ""
      },
      {
        id: "collateral-type",
        label: "担保抵押类型",
        selector: "#collateral-type",
        type: "select",
        options: ["信用免担保", "名下房产抵押", "名下车辆抵押", "第三方连带保证"],
        defaultValue: "信用免担保"
      },
      {
        id: "btn-submit-loan",
        label: "提交初审申请书",
        selector: "#btn-submit-loan",
        type: "button"
      }
    ]
  },
  {
    url: "/erp/loans/review",
    title: "信贷风控审批初核",
    description: "风险控制审计工作台 - 评估借款人信用等级，审查 DTI 负债收入比",
    fields: [
      {
        id: "risk-score-display",
        label: "自动化征信得分 (系统拉取)",
        selector: "#risk-score-display",
        type: "text",
        placeholder: "点此核对：系统评分为 720 (中低风险)",
        defaultValue: "720 (低风险级)"
      },
      {
        id: "dti-ratio-input",
        label: "核算负债收入比 (DTI %)",
        selector: "#dti-ratio-input",
        type: "number",
        placeholder: "核算公式：月偿债额 / 月收入 (例：42)",
        defaultValue: ""
      },
      {
        id: "audit-decision",
        label: "风控核批结论",
        selector: "#audit-decision",
        type: "select",
        options: ["建议授信通过", "退回重签/补充材料", "拒绝授信并拉黑"],
        defaultValue: "建议授信通过"
      },
      {
        id: "audit-comments",
        label: "风控授信批注意见",
        selector: "#audit-comments",
        type: "textarea",
        placeholder: "请在此处撰写不少于 20 字的授信额度裁决、潜在风险点说明...",
        defaultValue: ""
      },
      {
        id: "btn-confirm-review",
        label: "签署确认风控单",
        selector: "#btn-confirm-review",
        type: "button"
      }
    ]
  },
  {
    url: "/erp/customer/onboarding",
    title: "企业客户合规入驻",
    description: "KYC 及合规反洗钱认证 - 为新入驻合作伙伴开设 ERP 业务系统主账号",
    fields: [
      {
        id: "company-name",
        label: "企业法定全称",
        selector: "#company-name",
        type: "text",
        placeholder: "须与营业执照公章完全一致 (例：北京某某科技有限公司)",
        defaultValue: ""
      },
      {
        id: "social-credit-code",
        label: "统一社会信用代码",
        selector: "#social-credit-code",
        type: "text",
        placeholder: "18位数字与大写字母组合",
        defaultValue: ""
      },
      {
        id: "legal-representative",
        label: "企业法定代表人",
        selector: "#legal-representative",
        type: "text",
        placeholder: "法定代表人姓名",
        defaultValue: ""
      },
      {
        id: "contact-phone",
        label: "经办人联系电话",
        selector: "#contact-phone",
        type: "text",
        placeholder: "接收主账号密码与激活短信的手机号",
        defaultValue: ""
      },
      {
        id: "phone-verify-code",
        label: "短信验证密保",
        selector: "#phone-verify-code",
        type: "text",
        placeholder: "6位数字验证码 (例：582041)",
        defaultValue: ""
      },
      {
        id: "btn-submit-onboarding",
        label: "提交开户合规审核",
        selector: "#btn-submit-onboarding",
        type: "button"
      }
    ]
  }
];
