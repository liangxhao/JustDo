export type LoginStorageConfig = Readonly<{
  directoryName: string;
  userInfoFileName: string;
}>;

/** 登录信息存储配置；修改后重启 Electron 开发进程或重新打包。 */
export const LOGIN_STORAGE_CONFIG: LoginStorageConfig = Object.freeze({
  // 产品数据目录下的子目录名，不填写绝对路径；部署时可直接修改。
  directoryName: 'account',
  // 该目录中的用户信息文件名；目录还可存放其他业务文件。
  userInfoFileName: 'user_info.json',
});
