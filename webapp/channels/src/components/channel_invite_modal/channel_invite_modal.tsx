// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';
import {Modal} from 'react-bootstrap';
import {FormattedMessage} from 'react-intl';
import {isEqual} from 'lodash';

import GuestTag from 'components/widgets/tag/guest_tag';
import BotTag from 'components/widgets/tag/bot_tag';

import {Client4} from 'mattermost-redux/client';
import {RelationOneToOne} from '@mattermost/types/utilities';
import {ActionResult} from 'mattermost-redux/types/actions';
import {Channel} from '@mattermost/types/channels';
import {UserProfile} from '@mattermost/types/users';
import {Group, GroupSearachParams} from '@mattermost/types/groups';
import {TeamMembership} from '@mattermost/types/teams';

import {displayUsername, filterProfilesStartingWithTerm, isGuest} from 'mattermost-redux/utils/user_utils';
import {filterGroupsMatchingTerm} from 'mattermost-redux/utils/group_utils';
import {localizeMessage, sortUsersAndGroups} from 'utils/utils';
import ProfilePicture from 'components/profile_picture';
import MultiSelect, {Value} from 'components/multiselect/multiselect';
import AddIcon from 'components/widgets/icons/fa_add_icon';

import InvitationModal from 'components/invitation_modal';
import ToggleModalButton from 'components/toggle_modal_button';

import GroupOption from './group_option';
import TeamInviteBanner from './team_invite_banner';

import Constants, {ModalIdentifiers} from 'utils/constants';

const USERS_PER_PAGE = 50;
const USERS_FROM_DMS = 10;
const MAX_USERS = 25;

type UserProfileValue = Value & UserProfile;

type GroupValue = Value & Group;

export type Props = {
    profilesNotInCurrentChannel: UserProfile[];
    profilesInCurrentChannel: UserProfile[];
    profilesNotInCurrentTeam: UserProfile[];
    profilesFromRecentDMs: UserProfile[];
    membersInTeam: RelationOneToOne<UserProfile, TeamMembership>;
    userStatuses: RelationOneToOne<UserProfile, string>;
    onExited: () => void;
    channel: Channel;
    teammateNameDisplaySetting: string;

    // skipCommit = true used with onAddCallback will result in users not being committed immediately
    skipCommit?: boolean;

    // onAddCallback takes an array of UserProfiles and should set usersToAdd in state of parent component
    onAddCallback?: (userProfiles?: UserProfileValue[]) => void;

    // Dictionaries of userid mapped users to exclude or include from this list
    excludeUsers?: Record<string, UserProfileValue>;
    includeUsers?: Record<string, UserProfileValue>;
    canInviteGuests?: boolean;
    emailInvitationsEnabled?: boolean;
    groups: Group[];
    actions: {
        addUsersToChannel: (channelId: string, userIds: string[]) => Promise<ActionResult>;
        getProfilesNotInChannel: (teamId: string, channelId: string, groupConstrained: boolean, page: number, perPage?: number) => Promise<ActionResult>;
        getProfilesInChannel: (channelId: string, page: number, perPage: number, sort: string, options: {active?: boolean}) => Promise<ActionResult>;
        getTeamStats: (teamId: string) => void;
        loadStatusesForProfilesList: (users: UserProfile[]) => void;
        searchProfiles: (term: string, options: any) => Promise<ActionResult>;
        closeModal: (modalId: string) => void;
        searchAssociatedGroupsForReference: (prefix: string, teamId: string, channelId: string | undefined, opts: GroupSearachParams) => Promise<ActionResult>;
        getTeamMembersByIds: (teamId: string, userIds: string[]) => Promise<ActionResult>;
    };
}

type State = {
    values: UserProfileValue[];
    optionValues: Array<UserProfileValue | GroupValue>;
    usersNotInTeam: UserProfileValue[];
    guestsNotInTeam: UserProfileValue[];
    term: string;
    show: boolean;
    saving: boolean;
    loadingUsers: boolean;
    inviteError?: string;
}

export default class ChannelInviteModal extends React.PureComponent<Props, State> {
    private searchTimeoutId = 0;
    private selectedItemRef = React.createRef<HTMLDivElement>();

    public static defaultProps = {
        includeUsers: {},
        excludeUsers: {},
        skipCommit: false,
    };

    constructor(props: Props) {
        super(props);
        this.state = {
            values: [],
            usersNotInTeam: [],
            guestsNotInTeam: [],
            term: '',
            show: true,
            saving: false,
            loadingUsers: true,
            selectedValue: null,
            optionValues: [],
        } as State;
    }

    private addValue = (value: UserProfileValue | GroupValue): void => {
        const values: UserProfileValue[] = Object.assign([], this.state.values);
        const usersNotInTeam: UserProfileValue[] = Object.assign([], this.state.usersNotInTeam);
        const guestsNotInTeam: UserProfileValue[] = Object.assign([], this.state.guestsNotInTeam);

        if ('username' in value) {
            const profile = value;
            if (!this.props.membersInTeam || !this.props.membersInTeam[profile.id]) {
                if (isGuest(profile.roles)) {
                    if (guestsNotInTeam.indexOf(profile) === -1) {
                        this.setState((prevState) => {
                            return {guestsNotInTeam: [...prevState.guestsNotInTeam, profile]};
                        });
                    }
                    return;
                }
                if (usersNotInTeam.indexOf(profile) === -1) {
                    this.setState((prevState) => {
                        return {usersNotInTeam: [...prevState.usersNotInTeam, profile]};
                    });
                }
                return;
            }

            if (values.indexOf(profile) === -1) {
                this.setState((prevState) => {
                    return {values: [...prevState.values, profile]};
                });
            }
        }
    };

    private removeInvitedUsers = (profiles: UserProfile[]): void => {
        const usersNotInTeam: UserProfileValue[] = Object.assign([], this.state.usersNotInTeam);

        for (const profile of profiles) {
            const user = profile as UserProfileValue;
            const index = usersNotInTeam.indexOf(user);
            if (index !== -1) {
                usersNotInTeam.splice(index, 1);
            }

            this.addValue(user);
        }

        this.setState({usersNotInTeam: [...usersNotInTeam], guestsNotInTeam: []});
    };

    private removeUsersFromValuesNotInTeam = (profiles: UserProfile[]): void => {
        const usersNotInTeam: UserProfileValue[] = Object.assign([], this.state.usersNotInTeam);
        for (const profile of profiles) {
            const user = profile as UserProfileValue;
            const index = usersNotInTeam.indexOf(user);
            if (index !== -1) {
                usersNotInTeam.splice(index, 1);
            }
        }
        this.setState({usersNotInTeam: [...usersNotInTeam], guestsNotInTeam: []});
    };

    clearValuesNotInTeam = (): void => {
        this.setState({usersNotInTeam: [], guestsNotInTeam: []});
    };

    public componentDidMount(): void {
        this.props.actions.getProfilesNotInChannel(this.props.channel.team_id, this.props.channel.id, this.props.channel.group_constrained, 0).then(() => {
            this.setUsersLoadingState(false);
        });
        this.props.actions.getProfilesInChannel(this.props.channel.id, 0, USERS_PER_PAGE, '', {active: true});
        this.props.actions.getTeamStats(this.props.channel.team_id);
        this.props.actions.loadStatusesForProfilesList(this.props.profilesNotInCurrentChannel);
        this.props.actions.loadStatusesForProfilesList(this.props.profilesInCurrentChannel);
    }

    public async componentDidUpdate() {
        const values = this.getOptions();

        const userIds: string[] = [];

        for (let index = 0; index < values.length; index++) {
            const newValue = values[index];
            if ('username' in newValue) {
                userIds.push(newValue.id);
            } else if (newValue.member_ids) {
                userIds.push(...newValue.member_ids);
            }
        }

        if (!isEqual(values, this.state.optionValues)) {
            if (userIds.length > 0) {
                this.props.actions.getTeamMembersByIds(this.props.channel.team_id, userIds);
            }
            this.setState({optionValues: values});
        }
    }

    public getOptions = () => {
        let excludedAndNotInTeamUserIds: Set<string>;
        if (this.props.excludeUsers) {
            excludedAndNotInTeamUserIds = new Set(...this.props.profilesNotInCurrentTeam.map((user) => user.id), Object.values(this.props.excludeUsers).map((user) => user.id));
        } else {
            excludedAndNotInTeamUserIds = new Set(this.props.profilesNotInCurrentTeam.map((user) => user.id));
        }
        let users: Array<UserProfileValue | GroupValue> = this.filterOutDeletedAndExcludedAndNotInTeamUsers(
            filterProfilesStartingWithTerm(
                this.props.profilesNotInCurrentChannel.concat(this.props.profilesInCurrentChannel),
                this.state.term),
            excludedAndNotInTeamUserIds);

        if (this.props.includeUsers) {
            const includeUsers = Object.values(this.props.includeUsers);
            users = [...users, ...includeUsers];
        }
        const dmUsers = this.filterOutDeletedAndExcludedAndNotInTeamUsers(
            filterProfilesStartingWithTerm(this.props.profilesFromRecentDMs, this.state.term),
            excludedAndNotInTeamUserIds).
            slice(0, USERS_FROM_DMS) as UserProfileValue[];

        const groupsAndUsers = [
            ...filterGroupsMatchingTerm(this.props.groups, this.state.term) as GroupValue[],
            ...users,
        ].sort(sortUsersAndGroups);
        let optionValues = [
            ...dmUsers,
            ...groupsAndUsers,
        ].slice(0, MAX_USERS);

        optionValues = Array.from(new Set(optionValues));

        return optionValues;
    };

    public onHide = (): void => {
        this.setState({show: false});
        this.props.actions.loadStatusesForProfilesList(this.props.profilesNotInCurrentChannel);
        this.props.actions.loadStatusesForProfilesList(this.props.profilesInCurrentChannel);
    };

    public handleInviteError = (err: any): void => {
        if (err) {
            this.setState({
                saving: false,
                inviteError: err.message,
            });
        }
    };

    private handleDelete = (values: Array<UserProfileValue | GroupValue>): void => {
        // Our values for this component are always UserProfileValue
        const profiles = values as UserProfileValue[];
        this.setState({values: profiles});
    };

    private setUsersLoadingState = (loadingState: boolean): void => {
        this.setState({
            loadingUsers: loadingState,
        });
    };

    private handlePageChange = (page: number, prevPage: number): void => {
        if (page > prevPage) {
            this.setUsersLoadingState(true);
            this.props.actions.getProfilesNotInChannel(
                this.props.channel.team_id,
                this.props.channel.id,
                this.props.channel.group_constrained,
                page + 1, USERS_PER_PAGE).then(() => this.setUsersLoadingState(false));

            this.props.actions.getProfilesInChannel(this.props.channel.id, page + 1, USERS_PER_PAGE, '', {active: true});
        }
    };

    public handleSubmit = (): void => {
        const {actions, channel} = this.props;

        const userIds = this.state.values.map((v) => v.id);
        if (userIds.length === 0) {
            return;
        }

        if (this.props.skipCommit && this.props.onAddCallback) {
            this.props.onAddCallback(this.state.values);
            this.setState({
                saving: false,
                inviteError: undefined,
            });
            this.onHide();
            return;
        }

        this.setState({saving: true});

        actions.addUsersToChannel(channel.id, userIds).then((result: any) => {
            if (result.error) {
                this.handleInviteError(result.error);
            } else {
                this.setState({
                    saving: false,
                    inviteError: undefined,
                });
                this.onHide();
            }
        });
    };

    public search = (searchTerm: string): void => {
        const term = searchTerm.trim();
        clearTimeout(this.searchTimeoutId);
        this.setState({
            term,
        });

        this.searchTimeoutId = window.setTimeout(
            async () => {
                if (!term) {
                    return;
                }

                const options = {
                    team_id: this.props.channel.team_id,
                    not_in_channel_id: this.props.channel.id,
                    group_constrained: this.props.channel.group_constrained,
                };

                const opts = {
                    q: term,
                    filter_allow_reference: true,
                    page: 0,
                    per_page: 100,
                    include_member_count: true,
                    include_member_ids: true,
                };
                await Promise.all([
                    this.props.actions.searchProfiles(term, options),
                    this.props.actions.searchAssociatedGroupsForReference(term, this.props.channel.team_id, this.props.channel.id, opts),
                ]);
                this.setUsersLoadingState(false);
            },
            Constants.SEARCH_TIMEOUT_MILLISECONDS,
        );
    };

    private renderAriaLabel = (option: UserProfileValue | GroupValue): string => {
        if (!option) {
            return '';
        }
        if ('username' in option) {
            return option.username;
        }
        return option.name;
    };

    private filterOutDeletedAndExcludedAndNotInTeamUsers = (users: UserProfile[], excludeUserIds: Set<string>): UserProfileValue[] => {
        return users.filter((user) => {
            return user.delete_at === 0 && !excludeUserIds.has(user.id);
        }) as UserProfileValue[];
    };

    renderOption = (option: UserProfileValue | GroupValue, isSelected: boolean, onAdd: (option: UserProfileValue | GroupValue) => void, onMouseMove: (option: UserProfileValue | GroupValue) => void) => {
        let rowSelected = '';
        if (isSelected) {
            rowSelected = 'more-modal__row--selected';
        }

        if ('username' in option) {
            const ProfilesInGroup = this.props.profilesInCurrentChannel.map((user) => user.id);

            const userMapping: Record<string, string> = {};
            for (let i = 0; i < ProfilesInGroup.length; i++) {
                userMapping[ProfilesInGroup[i]] = 'Already in channel';
            }
            const displayName = displayUsername(option, this.props.teammateNameDisplaySetting);
            return (
                <div
                    key={option.id}
                    ref={isSelected ? this.selectedItemRef : option.id}
                    className={'more-modal__row clickable ' + rowSelected}
                    onClick={() => onAdd(option)}
                    onMouseMove={() => onMouseMove(option)}
                >
                    <ProfilePicture
                        src={Client4.getProfilePictureUrl(option.id, option.last_picture_update)}
                        status={this.props.userStatuses[option.id]}
                        size='md'
                        username={option.username}
                    />
                    <div className='more-modal__details'>
                        <div className='more-modal__name'>
                            <span>
                                {displayName}
                                {option.is_bot && <BotTag/>}
                                {isGuest(option.roles) && <GuestTag className='popoverlist'/>}
                                {displayName === option.username ?
                                    null :
                                    <span
                                        className='ml-2 light'
                                        style={{fontSize: '12px'}}
                                    >
                                        {'@'}{option.username}
                                    </span>
                                }
                                <span
                                    style={{position: 'absolute', right: 20}}
                                    className='light'
                                >
                                    {userMapping[option.id]}
                                </span>
                            </span>
                        </div>
                    </div>
                    <div className='more-modal__actions'>
                        <div className='more-modal__actions--round'>
                            <AddIcon/>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <GroupOption
                group={option}
                key={option.id}
                addUserProfile={onAdd}
                isSelected={isSelected}
                rowSelected={rowSelected}
                onMouseMove={onMouseMove}
                selectedItemRef={this.selectedItemRef}
            />
        );
    };

    public render = (): JSX.Element => {
        let inviteError = null;
        if (this.state.inviteError) {
            inviteError = (<label className='has-error control-label'>{this.state.inviteError}</label>);
        }

        const header = (
            <h1>
                <FormattedMessage
                    id='channel_invite.addNewMembers'
                    defaultMessage='Add people to {channel}'
                    values={{
                        channel: this.props.channel.display_name,
                    }}
                />
            </h1>
        );

        const buttonSubmitText = localizeMessage('multiselect.add', 'Add');
        const buttonSubmitLoadingText = localizeMessage('multiselect.adding', 'Adding...');

        const closeMembersInviteModal = () => {
            this.props.actions.closeModal(ModalIdentifiers.CHANNEL_INVITE);
        };

        const InviteModalLink = (props: {inviteAsGuest?: boolean; children: React.ReactNode}) => {
            return (
                <ToggleModalButton
                    id='inviteGuest'
                    className={`${props.inviteAsGuest ? 'invite-as-guest' : ''} btn btn-link`}
                    modalId={ModalIdentifiers.INVITATION}
                    dialogType={InvitationModal}
                    dialogProps={{
                        channelToInvite: this.props.channel,
                        initialValue: this.state.term,
                        inviteAsGuest: props.inviteAsGuest,
                    }}
                    onClick={closeMembersInviteModal}
                >
                    {props.children}
                </ToggleModalButton>
            );
        };

        const customNoOptionsMessage = (
            <div className='custom-no-options-message'>
                <FormattedMessage
                    id='channel_invite.no_options_message'
                    defaultMessage='No matches found - <InvitationModalLink>Invite them to the team</InvitationModalLink>'
                    values={{
                        InvitationModalLink: (chunks: string) => (
                            <InviteModalLink>
                                {chunks}
                            </InviteModalLink>
                        ),
                    }}
                />
            </div>
        );

        const content = (
            <MultiSelect
                key='addUsersToChannelKey'
                options={this.state.optionValues}
                optionRenderer={this.renderOption}
                selectedItemRef={this.selectedItemRef}
                values={this.state.values}
                ariaLabelRenderer={this.renderAriaLabel}
                saveButtonPosition={'bottom'}
                perPage={USERS_PER_PAGE}
                handlePageChange={this.handlePageChange}
                handleInput={this.search}
                handleDelete={this.handleDelete}
                handleAdd={this.addValue}
                handleSubmit={this.handleSubmit}
                handleCancel={closeMembersInviteModal}
                buttonSubmitText={buttonSubmitText}
                buttonSubmitLoadingText={buttonSubmitLoadingText}
                saving={this.state.saving}
                loading={this.state.loadingUsers}
                placeholderText={localizeMessage('multiselect.placeholder', 'Search for people')}
                valueWithImage={true}
                backButtonText={localizeMessage('multiselect.cancel', 'Cancel')}
                backButtonClick={closeMembersInviteModal}
                backButtonClass={'btn-cancel tertiary-button'}
                customNoOptionsMessage={this.props.emailInvitationsEnabled ? customNoOptionsMessage : null}
            />
        );

        const inviteGuestLink = (
            <InviteModalLink inviteAsGuest={true}>
                <FormattedMessage
                    id='channel_invite.invite_guest'
                    defaultMessage='Invite as a Guest'
                />
            </InviteModalLink>
        );

        return (
            <Modal
                id='addUsersToChannelModal'
                dialogClassName='a11y__modal channel-invite'
                show={this.state.show}
                onHide={this.onHide}
                onExited={this.props.onExited}
                role='dialog'
                aria-labelledby='channelInviteModalLabel'
            >
                <Modal.Header
                    id='channelInviteModalLabel'
                    closeButton={true}
                />
                <Modal.Body
                    role='application'
                    className='overflow--visible'
                >
                    <div className='channel-invite__header'>
                        {header}
                    </div>
                    {inviteError}
                    <div className='channel-invite__content'>
                        {content}
                        <TeamInviteBanner
                            guests={this.state.guestsNotInTeam}
                            teamId={this.props.channel.team_id}
                            users={this.state.usersNotInTeam}
                            clearValuesNotInTeam={this.clearValuesNotInTeam}
                            removeInvitedUsersCallback={this.removeInvitedUsers}
                            removeFailedInvitedUsersCallback={this.removeUsersFromValuesNotInTeam}
                        />
                        {(this.props.emailInvitationsEnabled && this.props.canInviteGuests) && inviteGuestLink}
                    </div>
                </Modal.Body>
            </Modal>
        );
    };
}
